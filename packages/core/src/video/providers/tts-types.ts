// [video-tts-types-v1] TTS 提供商统一接口。
// [WHY] orchestrator 只依赖此接口，具体实现（edge / azure / say）可替换。
// [CONSTRAINT] 返回值必须带 wordBoundaries（若实现支持）——字幕引擎依赖它，
//   缺失时由字幕层降级到 Whisper 转写。
import type { TTSResult } from '../types.js'

/** 单次 TTS 合成请求 */
export interface TTSOptions {
  voice: string
  rate?: number
  volume?: number
  outputPath: string
}

/** TTS 提供商契约 */
export interface TTSAdapter {
  /** 提供商标识（edge / azure / say） */
  readonly name: string
  /** 合成语音；失败抛错，不返回部分结果 */
  synthesize: (text: string, opts: TTSOptions) => Promise<TTSResult>
}
