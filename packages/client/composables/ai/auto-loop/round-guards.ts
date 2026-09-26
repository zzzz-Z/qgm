// [round-guards-v1] 从 useAutoLoop.ts 抽出；仅保留 ackFill 的 ACK 追踪职责
import type { LoopInstance } from './types.js'
import type { getTransport } from '../useAiTransport.js'
import type { useTraceLog } from '../../ui/useTraceLog'

interface RoundGuardsDeps {
  addTrace: ReturnType<typeof useTraceLog>['addTrace']
  transport: ReturnType<typeof getTransport>
}

/**
 * 创建 Round Guards
 * @param deps - deps
 */
export function createRoundGuards(deps: RoundGuardsDeps) {
  const { addTrace, transport } = deps

  /** 确认 AI 已填充脚本并更新状态 */
  function ackFill(inst: LoopInstance, label: string): void {
    if (typeof transport.waitAck !== 'function') return
    void transport.waitAck('headless:fill', '', 3000).then((ack) => {
      if (!ack) {
        addTrace({
          kind: 'loop',
          summary: `⚠ sendFill 3s 未 ACK（${label}）`,
          payload: { loopId: inst.id.value, loopRound: inst.round.value },
        })
      }
    }).catch(() => { /* ignore */ })
  }

  return { ackFill }
}
