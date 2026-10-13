// [video-subtitle-whisper-v1] Whisper 字幕：调 CLI 转写音频 → 解析 SRT。
// [WHY] Edge TTS 词边界缺失时（如 Azure / say）的唯一自动字幕来源。
// [CONSTRAINT] 依赖外部 whisper / whisper-cpp 可执行文件；缺失即抛错，
//   不做静默降级——静默降级会让「字幕没出」变成无法定位的谜团。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { SubtitleEntry } from './types.js'

/** 转写选项 */
export interface WhisperOptions {
  /** 可执行文件名（默认 whisper） */
  bin?: string
  /** 模型名（tiny/base/small/medium/large-v3-turbo） */
  model?: string
  /** 语言；默认 auto 由 Whisper 判定 */
  language?: string
  /** 输出目录（SRT 落这里） */
  outDir: string
}

/** 执行 CLI；非零退出抛错并附 stderr 尾部 */
function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args)
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', (e: Error) => reject(new Error(`${bin} 启动失败：${e.message}`)))
    child.on('close', (code: number | null) => {
      if (code === 0) resolve(stderr)
      else reject(new Error(`${bin} 退出码 ${code}\n${stderr.slice(-800)}`))
    })
  })
}

/** SRT 时间戳（HH:MM:SS,mmm）→ 秒 */
function parseTime(s: string): number {
  const m = s.trim().match(/^(\d+):(\d+):(\d+)[,.](\d+)$/)
  if (!m) return 0
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000
}

/** 解析 SRT 文本为字幕条目 */
export function parseSrt(text: string): SubtitleEntry[] {
  const out: SubtitleEntry[] = []
  const blocks = text.split(/\r?\n\r?\n/)
  for (const b of blocks) {
    const lines = b.split(/\r?\n/).filter(Boolean)
    if (lines.length < 3) continue
    const idx = Number(lines[0])
    const tm = lines[1].split('-->')
    if (tm.length !== 2) continue
    out.push({
      index: Number.isFinite(idx) ? idx : out.length + 1,
      start: parseTime(tm[0]),
      end: parseTime(tm[1]),
      text: lines.slice(2).join('\n'),
    })
  }
  return out
}

/** Whisper 转写：产出 SRT 并返回解析后的字幕条目 */
export async function transcribe(audioPath: string, opts: WhisperOptions): Promise<SubtitleEntry[]> {
  const bin = opts.bin || process.env.WHISPER_BIN || 'whisper'
  const model = opts.model || process.env.WHISPER_MODEL || 'large-v3-turbo'
  fs.mkdirSync(opts.outDir, { recursive: true })
  const args = [audioPath, '--model', model, '--output_format', 'srt', '--output_dir', opts.outDir]
  if (opts.language) args.push('--language', opts.language)
  await run(bin, args)
  const base = `${path.basename(audioPath).replace(/\.[^.]+$/, '')}.srt`
  const srtPath = path.join(opts.outDir, base)
  if (!fs.existsSync(srtPath)) throw new Error(`whisper 未产出 SRT：${srtPath}`)
  return parseSrt(fs.readFileSync(srtPath, 'utf8'))
}
