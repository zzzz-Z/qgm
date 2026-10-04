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
 * 容错解析 hooks 配置 JSON 字符串
 * [WHY] 配置文件由用户手写，格式错误不应导致启动失败；失败一律回落空对象
 * [CONSTRAINT] 只接受纯对象（数组 / null / 基础类型均回落空对象）
 * [CHANGE-IMPACT] 结果被 runHook 消费，空对象等价于"未配置任何 hook"
 * @param raw hooks.json 的文本内容
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

// [hooks-config-cache-v1] mtime 缓存：同一 mtime 的配置文件复用解析结果。
// [WHY] runHook 每轮循环触发多次（BeforeFill/BeforeScript/AfterScript/AfterResult/LoopStop），
//        每次读盘 + JSON.parse 造成持续 IO；hooks.json 变更频率极低。
// [CONSTRAINT] 以 path → { mtimeMs, parsed } 缓存；mtime 变化即失效。
// [CHANGE-IMPACT] 未改变解析语义；异常路径仍回落空对象。
interface HooksCacheEntry { mtimeMs: number, parsed: Record<string, HookDef[]> }
const _hooksCache = new Map<string, HooksCacheEntry>()

/** 从磁盘读取并解析 hooks 配置（带 mtime 缓存） */
export function loadHooksConfig(configPath: string): Record<string, HookDef[]> {
  try {
    const st = fs.statSync(configPath)
    const cached = _hooksCache.get(configPath)
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.parsed
    const parsed = parseHooksConfig(fs.readFileSync(configPath, 'utf8'))
    _hooksCache.set(configPath, { mtimeMs: st.mtimeMs, parsed })
    return parsed
  } catch {
    return {}
  }
}
