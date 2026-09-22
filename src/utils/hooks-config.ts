// AIRUNNER-BATCH11-1-HOOKS-CONFIG: 从 hooks.ts 抽出的配置加载与类型；无外部依赖，strip-types 可加载
import fs from 'node:fs'

export type HookEvent = 'BeforeFill' | 'BeforeScript' | 'AfterScript' | 'AfterResult' | 'LoopStop'

export interface HookDef {
  command: string
  onFail?: 'reject' | 'warn'
}

export interface HookResult {
  event: HookEvent
  action: 'ok' | 'reject'
  reason?: string
  hooksRun: number
}

/** 从原始文本解析 hooks 配置；坏 JSON 或非对象返回空。 */
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
