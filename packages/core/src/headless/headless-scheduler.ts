// [headless-scheduler-v1] 从 ai-headless.ts 抽出的调度辅助。
// [WHY] ai-headless.ts 超 §4 模块 400 行；SSE 解析 / 抖动 / 退避 / 429 监控无池状态依赖，可独立。
// [CHANGE-IMPACT] ai-headless.ts 通过 import + re-export 保持 API 兼容（parseDeepSeekCompletionError 仍可从原路径导入）。

/** 从 DeepSeek completion SSE 提取页面可能未渲染出来的错误提示。 */
export function parseDeepSeekCompletionError(raw: string): string | null {
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const eventLine = block.split(/\r?\n/).find(line => line.startsWith('event:'))
    if (eventLine?.slice(6).trim() !== 'hint') continue
    const dataLine = block.split(/\r?\n/).find(line => line.startsWith('data:'))
    if (!dataLine) continue
    try {
      const payload: unknown = JSON.parse(dataLine.slice(5).trim())
      if (!payload || typeof payload !== 'object') continue
      const hint = payload as { type?: unknown, content?: unknown }
      if (hint.type === 'error' && typeof hint.content === 'string') return hint.content
    } catch { /* 忽略格式错误的 SSE event，继续读后续 block */ }
  }
  return null
}

/**
 * 在 [minMs, maxMs) 区间内随机延迟后 resolve
 * [WHY] 固定间隔易被服务端识别为脚本；随机抖动模拟真人操作节奏
 * [CONSTRAINT] maxMs <= minMs 时按 minMs 恒定延迟；使用 Math.random 非加密随机
 * @param minMs 延迟下限（毫秒）
 * @param maxMs 延迟上限（毫秒，不含）
 */
export function jitterDelay(minMs: number, maxMs: number): Promise<void> {
  const span = Math.max(0, maxMs - minMs)
  const ms = minMs + Math.random() * span
  return new Promise(r => setTimeout(r, ms))
}

/**
 * 指数退避重试封装（仅对 429 / rate-limit / cooldown 生效）
 * [WHY] 服务端限流是暂时性故障，重试比直接失败更符合用户预期
 * [CONSTRAINT] 其他错误立即抛出；普通 429 退避 1s/2s/4s/8s/16s；
 *              带 cooldown 标记的频控拒收走 COOLDOWN_WAITS 长序列（站点要求整段冷却，短退避只会连续撞墙）
 * @param fn 待重试的异步操作
 * @param maxRetry 最大重试次数（默认 5）
 */
// [rate-retry-v1] 频控冷却退避序列（毫秒）：fill 被站点「过于频繁」拒收时按此序列等冷却后重发
export const COOLDOWN_WAITS = [15_000, 30_000, 60_000, 90_000, 120_000]

export async function withBackoff<T>(fn: () => Promise<T>, maxRetry = 5): Promise<T> {
  for (let i = 0; i <= maxRetry; i++) {
    try {
      return await fn()
    } catch (e) {
      const msg = String(e)
      if (!/429|rate.?limit|cooldown/i.test(msg) || i === maxRetry) throw e
      const wait = /cooldown/i.test(msg)
        ? COOLDOWN_WAITS[Math.min(i, COOLDOWN_WAITS.length - 1)]
        : 2 ** i * 1000
      await new Promise(r => setTimeout(r, wait))
    }
  }
  throw new Error('backoff 超限')
}

// 429 比例监控（滑动窗口，>10% 降频）
/** 速率窗口（100 次容量） */
const rateWindow: number[] = []

/** 记录一次请求结果到滑动窗口 */
export function recordRequest(is429: boolean): void {
  rateWindow.push(is429 ? 1 : 0)
  if (rateWindow.length > 100) rateWindow.shift()
}

/** 计算滑动窗口内 429 占比；窗口为空返回 0 */
export function rateLimitedRatio(): number {
  if (rateWindow.length === 0) return 0
  const sum = rateWindow.reduce((a, b) => a + b, 0)
  return sum / rateWindow.length
}
