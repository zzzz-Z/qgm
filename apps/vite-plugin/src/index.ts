// 薄包装：仅 re-export core 的实现，保持对外 API 不变。
// 拆分动机：core.ts 承载全部 HTTP 路由与插件装配；index.ts 保持入口稳定。
import type { AiRunnerOptions } from '@qgm/core'
import type { Plugin } from 'vite'
import { aiRunner as coreAiRunner } from './plugin.js'

export type { AiRunnerOptions } from '@qgm/core'

export function qgm(options: AiRunnerOptions = {}): Plugin {
  return coreAiRunner(options)
}
