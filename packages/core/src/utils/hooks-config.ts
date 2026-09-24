// AIRUNNER-BATCH11-1-HOOKS-CONFIG: 从 hooks.ts 抽出的配置加载与类型；无外部依赖，strip-types 可加载
import fs from 'node:fs'

/** 钩子触发事件枚举：BeforeFill / BeforeScript 等 */
export type HookEvent = 'BeforeFill' | 'BeforeScript' | 'AfterScript' | 'AfterResult' | 'LoopStop'

/** 单个钩子定义：事件、匹配规则、动作 */
export interface HookDef {
  command: string
  onFail?: 'reject' | 'warn'
}

/** 钩子执行结果：是否通过 + 拒绝原因 */
export interface HookResult {
  event: HookEvent
  action: 'ok' | 'reject'
  reason?: string
  hooksRun: number
}

/** 从原始文本解析 hooks 配置；坏 JSON 或非对象返回空。 */

/**
 * 解析 Hooks Config
 * @param raw - raw
 */
export function parseHooksConfig(raw: string): Record<string, HookDef[]> {
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, HookDef[]>
  } catch {
    return {}
  }
}

/** 从磁盘读取并解析 hooks 配置。 */
export function loadHooksConfig(configPath: string): Record<string, HookDef[]> {
  try {
    if (!fs.existsSync(configPath)) return {}
    return parseHooksConfig(fs.readFileSync(configPath, 'utf8'))
  } catch {
    return {}
  }
}
