// [video-routes-v1] /video 路由：任务创建/查询/删除/下载。
// [WHY] 前端面板消费的唯一入口；所有操作走此层，编排器不直接暴露给 HTTP。
// [CONSTRAINT] 编排器 provider 依赖在模块内惰性构造；无 Pexels Key 时降级到本地素材目录。
import { Hono } from 'hono'
import fs from 'node:fs'
import path from 'node:path'
import { getRoot } from '../config.js'
import { isMasked, loadConfig, maskConfig, saveConfig } from '../video/config.js'
import * as store from '../video/file-task-store.js'
import { startTask } from '../video/orchestrator.js'
import { LocalMaterialProvider } from '../video/providers/material-local.js'
import { SayTTSAdapter } from '../video/providers/tts-say.js'
import { EdgeTTSAdapter } from '../video/providers/tts-edge.js'
import { FallbackTTSAdapter } from '../video/providers/tts-fallback.js'
import type { VideoTaskParams } from '../video/types.js'

/** /video 路由 Hono 实例 */
export const videoHono = new Hono()

/** 组装 TTS：按配置选 provider；edge 走降级链，say 直接可用 */
function buildTTS() {
  const cfg = loadConfig()
  if (cfg.tts.provider === 'say') return new SayTTSAdapter()
  return new FallbackTTSAdapter(new EdgeTTSAdapter(), new SayTTSAdapter())
}

/** 依赖：TTS + 本地素材（默认目录为工作区内 assets/）；ffmpeg 走 bin/ */
function buildDeps() {
  const root = getRoot() || '.'
  return {
    tts: buildTTS(),
    material: new LocalMaterialProvider(path.join(root, 'assets')),
    ffmpegBin: path.join(root, 'bin', 'ffmpeg'),
    ffprobeBin: path.join(root, 'bin', 'ffprobe'),
  }
}

/** 创建视频任务：返回 taskId 与初始状态 */
videoHono.post('/tasks', async (c) => {
  let body: Record<string, unknown> = {}
  try { body = await c.req.json() as Record<string, unknown> } catch { return c.json({ ok: false, error: '请求体必须是 JSON' }, 400) }
  const subject = String(body.videoSubject || '').trim()
  if (!subject) return c.json({ ok: false, error: '缺少 videoSubject' }, 400)
  const params: VideoTaskParams = {
    videoSubject: subject,
    videoScript: body.videoScript ? String(body.videoScript) : undefined,
    videoTerms: Array.isArray(body.videoTerms) ? body.videoTerms.map(String) : undefined,
    videoSource: (body.videoSource as VideoTaskParams['videoSource']) || 'local',
    videoMaterials: Array.isArray(body.videoMaterials) ? body.videoMaterials.map(String) : undefined,
    aspect: body.aspect as VideoTaskParams['aspect'],
    voiceName: body.voiceName ? String(body.voiceName) : undefined,
    subtitleEnabled: body.subtitleEnabled !== false,
  }
  const state = await startTask(params, buildDeps())
  return c.json({ ok: state.status !== 'failed', taskId: state.taskId, status: state.status, error: state.error })
})

/** 任务列表；支持 limit 与 status 过滤 */
videoHono.get('/tasks', (c) => {
  const limit = Number(c.req.query('limit') || 50)
  const status = c.req.query('status')
  let items = store.listStates()
  if (status) items = items.filter(s => s.status === status)
  items = items.slice(0, Number.isFinite(limit) ? limit : 50)
  return c.json({ ok: true, items: items.map(s => ({
    taskId: s.taskId,
    status: s.status,
    progress: s.progress,
    stage: s.stage,
    subject: s.params.videoSubject,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    error: s.error,
  })) })
})

/** 任务详情 */
videoHono.get('/tasks/:id', (c) => {
  const st = store.readState(c.req.param('id'))
  if (!st) return c.json({ ok: false, error: '任务不存在' }, 404)
  return c.json({ ok: true, task: st })
})

/** 删除任务及其全部产物 */
videoHono.delete('/tasks/:id', (c) => {
  const ok = store.removeTask(c.req.param('id'))
  return c.json({ ok, removed: ok })
})

/** 下载成品；文件缺失返 404 */
videoHono.get('/tasks/:id/download', async (c) => {
  const st = store.readState(c.req.param('id'))
  if (!st || !st.outputPath || !fs.existsSync(st.outputPath)) return c.json({ ok: false, error: '成品不存在' }, 404)
  const buf = fs.readFileSync(st.outputPath)
  c.header('Content-Type', 'video/mp4')
  c.header('Content-Disposition', `attachment; filename="${st.taskId}.mp4"`)
  return c.body(new Uint8Array(buf))
})

/** 写入剧本文件（供编排器读取；由 AI 脚本落盘后也可直接 POST） */
videoHono.post('/tasks/:id/script', async (c) => {
  const id = c.req.param('id')
  if (!store.readState(id)) return c.json({ ok: false, error: '任务不存在' }, 404)
  let body: { script?: string } = {}
  try { body = await c.req.json() as { script?: string } } catch { /* ignore */ }
  const text = String(body.script || '').trim()
  if (!text) return c.json({ ok: false, error: '缺少 script' }, 400)
  const dir = store.taskDir(id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'script.txt'), text)
  return c.json({ ok: true })
})

/** 写入搜索词文件 */
videoHono.post('/tasks/:id/terms', async (c) => {
  const id = c.req.param('id')
  if (!store.readState(id)) return c.json({ ok: false, error: '任务不存在' }, 404)
  let body: { terms?: string[] } = {}
  try { body = await c.req.json() as { terms?: string[] } } catch { /* ignore */ }
  const terms = Array.isArray(body.terms) ? body.terms.map(String) : []
  if (!terms.length) return c.json({ ok: false, error: '缺少 terms' }, 400)
  const dir = store.taskDir(id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'terms.json'), JSON.stringify(terms, null, 2))
  return c.json({ ok: true })
})

/** 读取配置（敏感字段脱敏） */
videoHono.get('/config', (c) => {
  return c.json({ ok: true, config: maskConfig(loadConfig()) })
})

/** 更新配置（脱敏占位保留原值，不覆盖真实 Key） */
videoHono.put('/config', async (c) => {
  let body: Record<string, unknown> = {}
  try { body = await c.req.json() as Record<string, unknown> } catch { return c.json({ ok: false, error: '请求体必须是 JSON' }, 400) }
  const cur = loadConfig()
  const next = JSON.parse(JSON.stringify(cur)) as typeof cur
  // 只接受已知字段；敏感字段遇到 **** 视为「不改」
  const b = body as Partial<typeof cur>
  if (b.material) {
    if (typeof b.material.pexelsApiKey === 'string' && !isMasked(b.material.pexelsApiKey)) next.material.pexelsApiKey = b.material.pexelsApiKey
    if (typeof b.material.pixabayApiKey === 'string' && !isMasked(b.material.pixabayApiKey)) next.material.pixabayApiKey = b.material.pixabayApiKey
    if (typeof b.material.cacheTtlHours === 'number') next.material.cacheTtlHours = b.material.cacheTtlHours
  }
  if (b.tts) {
    if (b.tts.provider === 'edge' || b.tts.provider === 'say') next.tts.provider = b.tts.provider
    if (typeof b.tts.voice === 'string') next.tts.voice = b.tts.voice
    if (typeof b.tts.rate === 'number') next.tts.rate = b.tts.rate
    if (typeof b.tts.volume === 'number') next.tts.volume = b.tts.volume
  }
  if (b.azure) {
    if (typeof b.azure.apiKey === 'string' && !isMasked(b.azure.apiKey)) next.azure.apiKey = b.azure.apiKey
    if (typeof b.azure.region === 'string') next.azure.region = b.azure.region
  }
  if (b.video) {
    if (typeof b.video.aspect === 'string') next.video.aspect = b.video.aspect
    if (typeof b.video.bgmVolume === 'number') next.video.bgmVolume = b.video.bgmVolume
  }
  saveConfig(next)
  return c.json({ ok: true, config: maskConfig(next) })
})

/** BGM 列表：扫描 `.ai-runner/video/bgm/` */
videoHono.get('/musics', (c) => {
  const root = getRoot() || '.'
  const dir = path.join(root, '.ai-runner/video/bgm')
  if (!fs.existsSync(dir)) return c.json({ ok: true, items: [] })
  const items = fs.readdirSync(dir).filter(f => /\.(?:mp3|m4a|wav|aac)$/i.test(f))
  return c.json({ ok: true, items })
})

/** 上传 BGM：body 为 {name, contentBase64} */
videoHono.post('/musics', async (c) => {
  let body: { name?: string, contentBase64?: string } = {}
  try { body = await c.req.json() as { name?: string, contentBase64?: string } } catch { return c.json({ ok: false, error: '请求体必须是 JSON' }, 400) }
  const name = path.basename(String(body.name || ''))
  if (!name || !body.contentBase64) return c.json({ ok: false, error: '缺少 name 或 contentBase64' }, 400)
  const root = getRoot() || '.'
  const dir = path.join(root, '.ai-runner/video/bgm')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), Buffer.from(body.contentBase64, 'base64'))
  return c.json({ ok: true, path: path.join(dir, name) })
})

/** 本地素材列表：扫描工作区 `assets/` */
videoHono.get('/materials', (c) => {
  const root = getRoot() || '.'
  const dir = path.join(root, 'assets')
  if (!fs.existsSync(dir)) return c.json({ ok: true, items: [] })
  const items = fs.readdirSync(dir).filter(f => /\.(?:mp4|mov|webm|mkv|avi)$/i.test(f))
  return c.json({ ok: true, items })
})

/** 上传本地素材：body 为 {name, contentBase64} */
videoHono.post('/materials', async (c) => {
  let body: { name?: string, contentBase64?: string } = {}
  try { body = await c.req.json() as { name?: string, contentBase64?: string } } catch { return c.json({ ok: false, error: '请求体必须是 JSON' }, 400) }
  const name = path.basename(String(body.name || ''))
  if (!name || !body.contentBase64) return c.json({ ok: false, error: '缺少 name 或 contentBase64' }, 400)
  const root = getRoot() || '.'
  const dir = path.join(root, 'assets')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), Buffer.from(body.contentBase64, 'base64'))
  return c.json({ ok: true, path: path.join(dir, name) })
})

/** 分步：仅生成剧本提示词（给 AI 用；返回待写入路径与提示词） */
videoHono.post('/scripts', async (c) => {
  let body: { videoSubject?: string } = {}
  try { body = await c.req.json() as { videoSubject?: string } } catch { /* ignore */ }
  const subject = String(body.videoSubject || '').trim()
  if (!subject) return c.json({ ok: false, error: '缺少 videoSubject' }, 400)
  const taskId = store.newTaskId()
  const st = store.createInitialState(taskId, { videoSubject: subject, videoSource: 'local' })
  store.writeState(st)
  return c.json({ ok: true, taskId, scriptPath: path.join(store.taskDir(taskId), 'script.txt') })
})
