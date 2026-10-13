// [video-orchestrator-v1] 五阶段视频生成流水线主控。
// [WHY] 把「读剧本→取素材→合成→出片」的推进逻辑集中一处，各阶段实现细节由 provider 承担。
// [CONSTRAINT] 剧本与搜索词由外部 AI 脚本落盘，编排器只读不写——见方案 §二。
import fs from 'node:fs'
import path from 'node:path'
import * as store from './file-task-store.js'
import * as compositor from './compositor.js'
import { boundariesToEntries, entriesToSrt } from './subtitle.js'
import type { TaskState, VideoTaskParams } from './types.js'
import type { MaterialProvider } from './providers/material-types.js'
import type { TTSAdapter } from './providers/tts-types.js'

/** 阶段进度锚点，与 stopAt 检查点一一对应 */
const PROGRESS: Record<string, number> = {
  script: 10,
  terms: 20,
  audio: 50,
  materials: 70,
  compose: 100,
}

/** 编排器依赖注入：外部只提供 provider 实例，不关心实现 */
export interface OrchestratorDeps {
  tts: TTSAdapter
  material: MaterialProvider
  ffmpegBin?: string
  ffprobeBin?: string
}

/** 推进阶段：更新状态、写盘、返回是否应因 stopAt 而中止 */
function advance(state: TaskState, stage: string, stopAt?: string): boolean {
  state.stage = stage as TaskState['stage']
  state.progress = PROGRESS[stage] || state.progress
  state.status = 'processing'
  store.writeState(state)
  return stopAt === stage
}

/** 读取剧本文件；缺失即抛错，交由上层决定是否重新提需求 */
function readScript(dir: string): string {
  const file = path.join(dir, 'script.txt')
  if (!fs.existsSync(file)) throw new Error(`剧本文件不存在: ${file}`)
  return fs.readFileSync(file, 'utf8').trim()
}

/** 读取搜索词文件；缺失返回空数组（由调用方决定是否用主题兜底） */
function readTerms(dir: string): string[] {
  const file = path.join(dir, 'terms.json')
  if (!fs.existsSync(file)) return []
  try {
    const arr = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    return Array.isArray(arr) ? arr.map(String) : []
  } catch { return [] }
}

/** 写出每段素材需要的裁剪秒数（按音频总时长均分，末段吃余数） */
function clipSeconds(total: number, count: number): number[] {
  const per = total / count
  return Array.from({ length: count }, (_, i) => (i === count - 1 ? total - per * (count - 1) : per))
}

/** 生成 concat 列表文件内容 */
function concatList(files: string[]): string {
  return `${files.map(f => `file '${f.replace(/'/g, '\'\\\'\'')}'`).join('\n')}\n`
}

/** 素材去重：按来源 URL / 本地路径分组，组内保留时长最长的一条 */
// [video-material-dedup-v1] 对应 MPT 的 _prioritize_unique_source_clips。
// [WHY] 检索结果常含同一素材的多个规格；重复拼接会让画面反复出现同段。
function dedupMaterials<T extends { url?: string, localPath?: string, duration?: number }>(items: T[]): T[] {
  const groups = new Map<string, T[]>()
  for (const m of items) {
    const key = m.localPath || (m.url ? m.url.split('?')[0] : Math.random().toString(36))
    const list = groups.get(key) || []
    list.push(m)
    groups.set(key, list)
  }
  const out: T[] = []
  for (const list of groups.values()) {
    const best = list.reduce((a, b) => ((b.duration || 0) > (a.duration || 0) ? b : a))
    out.push(best)
  }
  return out
}

/** 主流程：创建任务 → 读剧本 → 读搜索词 → TTS 合成（可 stopAt 中止） */
export async function startTask(
  params: VideoTaskParams,
  deps: OrchestratorDeps,
): Promise<TaskState> {
  const taskId = store.newTaskId()
  const state = store.createInitialState(taskId, params)
  store.writeState(state)
  const dir = store.taskDir(taskId)
  const ffmpegBin = deps.ffmpegBin || 'ffmpeg'
  const ffprobeBin = deps.ffprobeBin || 'ffprobe'

  try {
    // 阶段 1：剧本（由外部 AI 脚本落盘）
    if (advance(state, 'script', params.stopAt)) return state
    state.scriptPath = path.join(dir, 'script.txt')
    const script = params.videoScript || readScript(dir)
    store.writeState(state)

    // 阶段 2：搜索词
    if (advance(state, 'terms', params.stopAt)) return state
    const terms = params.videoTerms && params.videoTerms.length ? params.videoTerms : readTerms(dir)
    state.termsPath = path.join(dir, 'terms.json')
    store.writeState(state)

    // 阶段 3：TTS 合成 + 字幕生成
    if (advance(state, 'audio', params.stopAt)) return state
    const audioPath = path.join(dir, 'audio.mp3')
    const tts = await deps.tts.synthesize(script, {
      voice: params.voiceName || 'Tingting',
      rate: params.voiceRate,
      volume: params.voiceVolume,
      outputPath: audioPath,
    })
    state.audioPath = tts.audioPath
    if (params.subtitleEnabled !== false && tts.wordBoundaries && tts.wordBoundaries.length) {
      const srt = entriesToSrt(boundariesToEntries(tts.wordBoundaries))
      state.subtitlePath = path.join(dir, 'subtitle.srt')
      fs.writeFileSync(state.subtitlePath, srt)
    }
    store.writeState(state)
    return await finishPipeline(state, deps, { script, terms, ffmpegBin, ffprobeBin, duration: tts.duration })
  } catch (e) {
    state.status = 'failed'
    state.error = String(e)
    store.writeState(state)
    return state
  }
}

/** 阶段 4-5：获取素材 → 标准化 → 拼接 → 混音字幕 → 出片 */
async function finishPipeline(
  state: TaskState,
  deps: OrchestratorDeps,
  ctx: { script: string, terms: string[], ffmpegBin: string, ffprobeBin: string, duration: number },
): Promise<TaskState> {
  const dir = store.taskDir(state.taskId)
  const { ffmpegBin, ffprobeBin, terms, duration } = ctx
  const params = state.params
  const aspect = params.aspect || '9:16'

  // 阶段 4：素材获取
  if (advance(state, 'materials', params.stopAt)) return state
  const mats = params.videoMaterials && params.videoMaterials.length
    ? params.videoMaterials.map(p => ({ provider: params.videoSource, url: '', duration: 0, width: 0, height: 0, localPath: p }))
    : dedupMaterials(await deps.material.search(terms.length ? terms : [params.videoSubject], { aspect, limit: 6 }))
  if (!mats.length) throw new Error('未获取到任何素材')
  const matDir = path.join(dir, 'materials')
  fs.mkdirSync(matDir, { recursive: true })
  const downloaded: string[] = []
  for (let i = 0; i < mats.length; i++) {
    const dest = path.join(matDir, `clip_${String(i + 1).padStart(2, '0')}.mp4`)
    downloaded.push(await deps.material.download(mats[i], dest))
  }
  state.materialPaths = downloaded
  store.writeState(state)

  // 阶段 5：合成
  if (advance(state, 'compose', params.stopAt)) return state
  const encoder = await compositor.pickVideoEncoder(ffmpegBin)
  const secs = clipSeconds(duration, downloaded.length)
  const normDir = path.join(dir, 'normalized')
  fs.mkdirSync(normDir, { recursive: true })
  const normalized: string[] = []
  for (let i = 0; i < downloaded.length; i++) {
    const out = path.join(normDir, `n_${String(i + 1).padStart(2, '0')}.mp4`)
    await compositor.runFfmpeg(ffmpegBin, compositor.normalizeClipArgs(downloaded[i], out, secs[i], aspect, encoder))
    normalized.push(out)
  }
  const listFile = path.join(dir, 'concat.txt')
  fs.writeFileSync(listFile, concatList(normalized))
  const combined = path.join(dir, 'combined.mp4')
  await compositor.runFfmpeg(ffmpegBin, compositor.concatArgs(listFile, combined))
  state.combinedPath = combined

  const finalOut = path.join(dir, 'final.mp4')
  await compositor.runFfmpeg(ffmpegBin, compositor.finalizeArgs({
    video: combined,
    audio: state.audioPath!,
    bgm: params.bgmPath,
    subtitle: state.subtitlePath,
    output: finalOut,
    bgmVolume: params.bgmVolume ?? 0.3,
    encoder,
  }))
  state.outputPath = finalOut
  state.status = 'completed'
  state.progress = 100
  state.stage = 'compose'
  store.writeState(state)
  return state
}
