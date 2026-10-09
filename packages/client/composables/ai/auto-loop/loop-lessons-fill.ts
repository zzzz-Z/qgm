// [loop-lessons-refresh-v1] 循环轮末回传前，按本轮错误重检索 lessons 并注入。
// [WHY] 首轮注入按 goal 检索一次；中途遇到全新类型错误时不会重检索（goal 没变）。
//   本模块在每轮回传前用本轮 stderr/desc 作 query 再检索一次，把命中注入到 prompt 尾部。
// [CONSTRAINT] 检索失败 / 空 query / 无命中 → 原 prompt 原样发出，绝不阻断回传。
// [CHANGE-IMPACT] 被 reply-handlers.ts 的 flushRoundOutcome 消费；prompt 体积受 lessons 预算 6000 约束。
import type { RoundOutcome } from './types.js'
import { buildRoundBatchPrompt } from './loop-result-prompt.js'
import { buildLessonsBlock } from '../load-lessons.js'
import { fetchBoardMirror } from '../board-mirror.js'
import type { getTransport } from '../useAiTransport.js'

type Transport = ReturnType<typeof getTransport>

/**
 * 从本轮结果构造检索 query：失败块的 stderr 摘要优先，其次 desc 拼接。
 * [CONSTRAINT] 截断到 2000 字符，避免超大报错撑爆检索；无错误时退回任务描述。
 */
export function buildLessonsQuery(outcomes: RoundOutcome[]): string {
  const failPieces: string[] = []
  const descPieces: string[] = []
  for (const o of outcomes) {
    if (o.desc) descPieces.push(o.desc)
    if (!o.ok && o.stderr) failPieces.push(o.stderr.slice(-300))
  }
  const q = failPieces.length ? failPieces.join(String.fromCharCode(10)) : descPieces.join(' · ')
  return q.slice(0, 2000)
}

/**
 * 出站前按本轮错误检索 lessons 并注入；任何失败均不阻断回传。
 * [CONSTRAINT] isAborted() 为真时放弃出站（与 flushRoundOutcome 的 false 语义一致）。
 */
export async function fillWithLessons(
  transport: Transport,
  outcomes: RoundOutcome[],
  isAborted: () => boolean,
): Promise<void> {
  if (isAborted()) return
  const base = buildRoundBatchPrompt(outcomes)
  let prompt = base
  try {
    const block = await buildLessonsBlock(buildLessonsQuery(outcomes))
    if (block) prompt = `${base}${String.fromCharCode(10, 10)}${block}`
  } catch { /* 检索失败 → 原 prompt 原样发出 */ }
  // [board-mirror-v1] 看板状态常驻上下文：每轮回传都把未完成任务（带 id）递到 AI 面前。
  // [WHY] 看板与脚本执行零联动，AI 不记账就永远不动（实测 21 个脚本成功、看板 0/7 冻结）。
  // [CONSTRAINT] 与 lessons 同纪律：抓取失败即原样发出，绝不阻断回传。
  try {
    const board = await fetchBoardMirror()
    if (board) prompt = `${prompt}${String.fromCharCode(10, 10)}${board}`
  } catch { /* 看板不可用时原 prompt 原样发出 */ }
  try {
    if (!isAborted()) transport.sendFill('', { prompt })
  } catch { /* 出站异常不逃逸（void 调用方） */ }
}
