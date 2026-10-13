// [video-tts-edge-v1] Edge TTS 适配器：走 msedge-tts（在线，含词边界）。
// [WHY] 词边界是字幕对齐关键；say 无此能力，Edge TTS 是当前最优解。
// [CONSTRAINT] msedge-tts 从工作区隔离目录动态加载（不进 workspace 依赖），
//   路径可由 EDGE_TTS_PATH 覆盖；加载失败即抛错，由调用方降级到 say。
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { getRoot } from '../../config.js'
import type { TTSResult, WordBoundary } from '../types.js'
import type { TTSAdapter, TTSOptions } from './tts-types.js'

/** 用到的 msedge-tts 方法签名（避免依赖其 .d.ts 类型） */
interface EdgeTtsLike {
  setMetadata: (voice: string, format: string, opts?: { wordBoundaryEnabled?: boolean }) => Promise<void>
  toStream: (text: string, prosody?: { rate?: number }) => {
    audioStream: { on: (ev: string, cb: (d: unknown) => void) => void }
    metadataStream: { on: (ev: string, cb: (d: unknown) => void) => void } | null
  }
}

interface EdgeTtsModule {
  MsEdgeTTS: new (opts?: { enableLogger?: boolean }) => EdgeTtsLike
  OUTPUT_FORMAT: Record<string, string>
}

/** msedge-tts dist 入口；可经 EDGE_TTS_PATH 覆盖 */
function resolveEdgeTtsPath(): string {
  if (process.env.EDGE_TTS_PATH) return process.env.EDGE_TTS_PATH
  const root = getRoot() || process.cwd()
  return path.join(root, '.ai-runner/video-tools/node_modules/msedge-tts/dist/index.js')
}

/** 解析 metadataStream 内的 WordBoundary 块（每块一个 JSON 对象） */
function parseBoundaries(raw: string): WordBoundary[] {
  const out: WordBoundary[] = []
  const re = /\{[\s\S]*?"WordBoundary"[\s\S]*?\}/g
  for (const m of raw.match(re) || []) {
    try {
      const obj = JSON.parse(m) as { Metadata?: Array<{ Data?: { Offset?: number, Duration?: number, text?: { Text?: string } } }> }
      const d = obj.Metadata?.[0]?.Data
      if (!d?.text?.Text) continue
      const start = Number(d.Offset || 0) / 1e7
      const dur = Number(d.Duration || 0) / 1e7
      out.push({ word: d.text.Text, start, end: start + dur })
    } catch { /* 单块解析失败不影响其他块 */ }
  }
  return out
}

/** 默认音色 */
const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural'

/** Edge TTS 适配器 */
export class EdgeTTSAdapter implements TTSAdapter {
  readonly name = 'edge'

  async synthesize(text: string, opts: TTSOptions): Promise<TTSResult> {
    const modPath = resolveEdgeTtsPath()
    if (!fs.existsSync(modPath)) throw new Error(`msedge-tts 未安装：${modPath}`)
    const mod = await import(pathToFileURL(modPath).href) as EdgeTtsModule
    const tts = new mod.MsEdgeTTS({ enableLogger: false })
    const fmt = mod.OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3
    await tts.setMetadata(opts.voice || DEFAULT_VOICE, fmt, { wordBoundaryEnabled: true })
    const prosody = opts.rate && opts.rate !== 1 ? { rate: opts.rate } : undefined
    const { audioStream, metadataStream } = tts.toStream(text, prosody)
    const chunks: Buffer[] = []
    const meta: string[] = []
    audioStream.on('data', (d: unknown) => { chunks.push(Buffer.from(d as Uint8Array)) })
    if (metadataStream) metadataStream.on('data', (d: unknown) => { meta.push(String(d)) })
    await new Promise<void>((resolve, reject) => {
      audioStream.on('close', () => resolve())
      audioStream.on('error', (e: unknown) => reject(e instanceof Error ? e : new Error(String(e))))
    })
    fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true })
    fs.writeFileSync(opts.outputPath, Buffer.concat(chunks))
    const boundaries = parseBoundaries(meta.join(''))
    const duration = boundaries.length ? boundaries[boundaries.length - 1].end : 0
    return { audioPath: opts.outputPath, duration, wordBoundaries: boundaries }
  }
}
