// [video-subtitle-v1] 字幕生成：词边界转 SRT，或调用 Whisper CLI 转写。
// [WHY] 字幕有两个来源——TTS 直出的词边界（快，无转写误差）与 Whisper 转写（慢，但通用）。
// [CONSTRAINT] 词边界优先；缺失时才走 Whisper，避免无谓的重活。
import type { SubtitleEntry, WordBoundary } from './types.js'

/** 秒 → SRT 时间戳格式（HH:MM:SS,mmm） */
function fmtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000))
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const tail = ms % 1000
  const p2 = (n: number) => String(n).padStart(2, '0')
  const p3 = (n: number) => String(n).padStart(3, '0')
  return `${p2(h)}:${p2(m)}:${p2(s)},${p3(tail)}`
}

/** 词边界 → 字幕条目：按 maxChars 合并短词，减少跳字 */
export function boundariesToEntries(boundaries: WordBoundary[], maxChars = 18): SubtitleEntry[] {
  const out: SubtitleEntry[] = []
  let buf: WordBoundary[] = []
  let len = 0
  const flush = () => {
    if (!buf.length) return
    out.push({
      index: out.length + 1,
      start: buf[0].start,
      end: buf[buf.length - 1].end,
      text: buf.map(b => b.word).join(''),
    })
    buf = []
    len = 0
  }
  for (const b of boundaries) {
    if (len + b.word.length > maxChars && buf.length) flush()
    buf.push(b)
    len += b.word.length
  }
  flush()
  return out
}

/** 字幕条目 → SRT 文本 */
export function entriesToSrt(entries: SubtitleEntry[]): string {
  return entries.map(e => [
    String(e.index),
    `${fmtTime(e.start)} --> ${fmtTime(e.end)}`,
    e.text,
    '',
  ].join('\n')).join('\n')
}
