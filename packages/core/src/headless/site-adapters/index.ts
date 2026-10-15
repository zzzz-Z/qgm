// [site-adapters-v1] 站点适配器 barrel + 工厂
import type { SiteAdapter } from './types.js'
import { deepseekAdapter } from './deepseek.js'
import { chatglmAdapter } from './chatglm.js'

/** 所有已注册适配器 */
export const ALL_ADAPTERS: Record<string, SiteAdapter> = {
  deepseek: deepseekAdapter,
  chatglm: chatglmAdapter,
}

/** 当前默认适配器（由环境变量 AI_SITE_ADAPTER 覆盖） */
export function getDefaultAdapter(): SiteAdapter {
  const env = process.env.AI_SITE_ADAPTER?.trim().toLowerCase() || ''
  if (env && ALL_ADAPTERS[env]) return ALL_ADAPTERS[env]
  return deepseekAdapter
}

/** 按 name 取 adapter，找不到回退 default */
export function getAdapter(name?: string): SiteAdapter {
  if (name && ALL_ADAPTERS[name]) return ALL_ADAPTERS[name]
  return getDefaultAdapter()
}

export type { SiteAdapter } from './types.js'
