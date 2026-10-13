// [video-tts-fallback-v1] TTS 降级适配器：优先主选，失败自动切兜底。
// [WHY] Edge TTS 提供词边界（字幕对齐），但依赖网络；say 离线可用但无词边界。
//   把降级逻辑收在一处，orchestrator 只见一个 TTSAdapter。
// [CONSTRAINT] 只在「主选抛错」时降级，不吞主选的成功结果；
//   降级后返回的 wordBoundaries 可能缺失，字幕层需自行处理。
import type { TTSResult } from '../types.js'
import type { TTSAdapter, TTSOptions } from './tts-types.js'

/** 带降级的 TTS 适配器 */
export class FallbackTTSAdapter implements TTSAdapter {
  readonly name: string

  /** @param primary 主选（如 edge）；@param fallback 兜底（如 say） */
  constructor(private readonly primary: TTSAdapter, private readonly fallback: TTSAdapter) {
    this.name = `${primary.name}|${fallback.name}`
  }

  async synthesize(text: string, opts: TTSOptions): Promise<TTSResult> {
    try {
      return await this.primary.synthesize(text, opts)
    } catch (e) {
      console.warn(`[video-tts] 主选 ${this.primary.name} 失败，降级到 ${this.fallback.name}：${String(e).slice(0, 200)}`)
      return await this.fallback.synthesize(text, opts)
    }
  }
}
