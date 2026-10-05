// [session-isolation-v1] 循环实例的会话归属判定（纯函数，零副作用）。
// [WHY] 从 useAutoLoop.ts 抽出：让实现与守卫测试共用同一代码路径——
//   实现若被改回「忽略 sid 恒返回单例」，测试立刻红，而不是靠抄副本空转。
import type { LoopInstance } from './types.js'

/**
 * 按 sid 从候选实例挑选可路由的循环；不匹配返回 null。
 * [CONSTRAINT] 兼容矩阵（任一方为空即放行，兼容旧油猴无 sessionId）：
 *   ① 双方都有 sid 且相等 → 放行；
 *   ② 双方都有但不等 → 拒绝（隔离核心语义）；
 *   ③ 任一方为空 → 放行（保持旧行为）。
 * @param inst 候选循环实例（可为 null）
 * @param sid 消息携带的会话 id（可为空串）
 */
export function pickInstanceBySessionId(inst: LoopInstance | null, sid: string): LoopInstance | null {
  if (!inst) return null
  const bound = inst.sessionId.value
  if (!bound || !sid) return inst
  return sid === bound ? inst : null
}
