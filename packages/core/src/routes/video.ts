// [video-routes-v1] /video 路由：任务创建/查询/删除/下载。
// [WHY] 前端面板消费的唯一入口；所有操作走此层，编排器不直接暴露给 HTTP。
// [CONSTRAINT] 编排器 provider 依赖在模块内惰性构造；无 Pexels Key 时降级到本地素材目录。
import { Hono } from 'hono'
import fs from 'node:fs'
import path from 'node:path'
import { getRoot } from '../config.js'
import * as store from '../video/file-task-store.js'
import { startTask } from '../video/orchestrator.js'
import { LocalMaterialProvider } from '../video/providers/material-local.js'
import { SayTTSAdapter } from '../video/providers/tts-say.js'
import { EdgeTTSAdapter } from '../video/providers/tts-edge.js'
import { FallbackTTSAdapter } from '../video/providers/tts-fallback.js'
import type { VideoTaskParams } from '../video/types.js'

/** /video 路由 Hono 实例 */
export const videoHono = new Hono()

/** 依赖：say TTS + 本地素材（默认目录为工作区内 assets/） */
function buildDeps() {
  const root = getRoot() || '.'
  return {
    tts: new FallbackTTSAdapter(new EdgeTTSAdapter(), new SayTTSAdapter()),
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
