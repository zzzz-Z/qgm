// [round-guards-v1] 从 useAutoLoop.ts 抽出；仅保留 ackFill 的 ACK 追踪职责
import type { LoopInstance } from './types.js'
import type { getTransport } from '../useAiTransport.js'

interface RoundGuardsDeps {
  transport: ReturnType<typeof getTransport>
}

/**
 * 组装轮次守卫（当前仅 ackFill）
 * [WHY] 把 waitAck 这类"发后确认"逻辑从 useAutoLoop 抽出，降低单文件体积
 * [CONSTRAINT] deps.transport 由 useAutoLoop 注入；本模块无模块级状态
 * [CHANGE-IMPACT] 新增守卫函数须同步更新 useAutoLoop 的解构与调用点
 * @param deps 守卫依赖面（当前仅含 transport）
 */
export function createRoundGuards(deps: RoundGuardsDeps) {
  const { transport } = deps

  /** 确认 AI 已填充脚本并更新状态 */
  function ackFill(_inst: LoopInstance, _label: string): void {
    if (typeof transport.waitAck !== 'function') return
    void transport.waitAck('headless:fill', '', 3000).catch(() => { /* ignore */ })
  }

  return { ackFill }
}
