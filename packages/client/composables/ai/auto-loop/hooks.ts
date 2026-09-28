// 生命周期 hook（HTTP 调用 /__hooks/run）

/** 循环生命周期事件枚举；[CONSTRAINT] 与 core/src/utils/hooks-config.ts 的事件表一一对应，改名单需两侧同步 */
export type HookEvent = 'BeforeFill' | 'BeforeScript' | 'AfterScript' | 'AfterResult' | 'LoopStop'
/** 钩子执行结果：是否通过 + 拒绝原因 */
export interface HookResult {
  event: HookEvent
  action: 'ok' | 'reject'
  reason?: string
  hooksRun: number
}

/**
 * 通过 HTTP 触发服务端 hook 链
 * [WHY] hook 配置（脚本路径 / 超时）在服务端集中管理，前端只需 post event + payload
 * [CONSTRAINT] 网络失败或响应非 2xx 一律降级为 `{action:'ok', hooksRun:0}`，不阻断循环流程
 * [CHANGE-IMPACT] 返回值决定 start-family / stop-and-finish 中是否走 reject 分支
 * @param event 生命周期事件名
 * @param payload 事件体；结构由各 hook 脚本自行约定，此处不校验
 */
export async function runHook(event: HookEvent, payload: unknown): Promise<HookResult> {
  try {
    const res = await fetch('/__ai/hooks/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, payload }),
    })
    if (!res.ok) return { event, action: 'ok', hooksRun: 0 }
    return await res.json() as HookResult
  } catch {
    return { event, action: 'ok', hooksRun: 0 }
  }
}
