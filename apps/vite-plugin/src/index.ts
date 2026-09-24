// 薄包装：仅 re-export core 的实现，保持对外 API 不变。
// 拆分动机：core.ts 承载全部 HTTP 路由与插件装配；index.ts 保持入口稳定。
import type { AiRunnerOptions } from '@qgm/ai-runner-core'
import type { Plugin } from 'vite'
import { aiRunner as coreAiRunner } from './plugin.js'

export type { AiRunnerOptions } from '@qgm/ai-runner-core'

/**
 * 执行 ai Runner
 * @param options - options
 */
export function aiRunner(options: AiRunnerOptions = {}): Plugin {
  return coreAiRunner(options)
}
