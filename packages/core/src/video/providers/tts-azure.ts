// [video-tts-azure-v1] Azure 语音服务适配器：REST 合成 + 语速/音量。
// [WHY] 音质优于 Edge TTS；企业账号可用的高端选项。
// [CONSTRAINT] REST v1 单次调用不返回词边界事件（那需 SDK 或 WebSocket）——
//   本实现返回空 wordBoundaries，字幕层自动降级（Whisper 或按句切）。
import fs from 'node:fs'
import path from 'node:path'
import type { TTSResult } from '../types.js'
import type { TTSAdapter, TTSOptions } from './tts-types.js'

/** 默认音色（Azure 命名） */
const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural'

/** 输出格式（24kHz 48kbps MP3，与 Edge 一致便于下游复用） */
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3'

/** XML 特殊字符转义，避免 SSML 被注入破坏 */
function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/** 组装 SSML 请求体 */
function buildSsml(text: string, voice: string, rate: number, volume: number): string {
  const ratePct = Math.round((rate - 1) * 100)
  const volPct = Math.round((volume - 1) * 100)
  const rateAttr = ratePct >= 0 ? `+${ratePct}%` : `${ratePct}%`
  const volAttr = volPct >= 0 ? `+${volPct}%` : `${volPct}%`
  return [
    '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN">',
    `  <voice name="${voice}">`,
    `    <prosody rate="${rateAttr}" volume="${volAttr}">${escapeXml(text)}</prosody>`,
    '  </voice>',
    '</speak>',
  ].join('')
}

/** Azure TTS 适配器 */
export class AzureTTSAdapter implements TTSAdapter {
  readonly name = 'azure'

  /** @param apiKey 订阅密钥；@param region 区域（如 eastasia） */
  constructor(private readonly apiKey: string, private readonly region: string) {}

  async synthesize(text: string, opts: TTSOptions): Promise<TTSResult> {
    if (!this.apiKey) throw new Error('Azure TTS 缺少 apiKey')
    if (!this.region) throw new Error('Azure TTS 缺少 region')
    const url = `https://${this.region}.tts.speech.microsoft.com/cognitiveservices/v1`
    const ssml = buildSsml(text, opts.voice || DEFAULT_VOICE, opts.rate ?? 1, opts.volume ?? 1)
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': this.apiKey,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': OUTPUT_FORMAT,
      },
      body: ssml,
    })
    if (!res.ok) throw new Error(`Azure TTS 合成失败：${res.status} ${(await res.text()).slice(0, 200)}`)
    fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true })
    fs.writeFileSync(opts.outputPath, Buffer.from(await res.arrayBuffer()))
    // REST 版无词边界；duration 由下游 ffprobe 探测
    return { audioPath: opts.outputPath, duration: 0, wordBoundaries: [] }
  }
}
