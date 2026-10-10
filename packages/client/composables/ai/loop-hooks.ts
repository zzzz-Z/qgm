// [hooks-relocate-v1] 从 auto-loop/hooks.ts 迁出（P1b）：runHook 是通用 HTTP hook 调用，
//   与循环状态机无关；留在 auto-loop/ 内会随 P3 删目录一起死，而非循环 DONE 分支需要它。
// 生命周期 hook（HTTP 调用 /__hooks/run）

/** 循环生命周期事件枚举；[CONSTRAINT] 与 core/src/utils/hooks-config.ts 的事件表一一对应，改名单需两侧同步 */
export type HookEventImpl = 'BeforeFill' | 'BeforeScript' | 'AfterScript' | 'AfterResult' | 'LoopStop' | 'BeforeDone' | 'BeforeDoneFinal'
/** 钩子执行结果：是否通过 + 拒绝原因 */
export interface HookResultImpl {
  event: HookEventImpl
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
export async function runHook(event: HookEventImpl, payload: unknown): Promise<HookResultImpl> {
  try {
    const res = await fetch('/__ai/hooks/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, payload }),
    })
    if (!res.ok) return { event, action: 'ok', hooksRun: 0 }
    return await res.json() as HookResultImpl
  } catch {
    return { event, action: 'ok', hooksRun: 0 }
  }
}
