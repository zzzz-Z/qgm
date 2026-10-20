// @ts-nocheck
// [tampermonkey-ts-rewrite-v1] IIFE 物理切分片段，非独立模块；跨片段符号在单文件检查下不可见。
//   全部片段 TS 化完成、按拼回后的联合视图接线后再移除本 pragma。

/**
 * 回复检测 —— dispatch 的输入源：正文签名、最新回复全文、DOM→Markdown 反推。
 *
 * [legacy-marks-removed-v1] 旧架构的「首行 DONE 标记」检测已删：契约 §1 规定回复只能是
 *   turn 信封，任务收尾由宿主机制判定（SYSTEM.md §1「turn 总结 ≠ 任务 DONE」）。
 *
 * [CONSTRAINT] 这些函数在「assistant 容器缺失」时必须一致地**什么都不做**：
 *   新会话首轮「已思考/搜索」阶段没有回复容器，此时整页反推会把侧栏历史会话标题
 *   与用户首条消息（SYSTEM.md 卡）拼成「回复」，表现为噪音。
 *   这条约束在各函数里分别写一次，是有意为之——任何一个漏掉都会单独产生噪音。
 */

/**
 * 正文签名 —— 判断「正文是否变了」的指纹。
 * [WHY] 优先用最后一条 AI 回复容器的文本：整页末 300 字符在多数站点是输入框/页脚，
 *   AI 流式期间恒定 ⇒ 签名不变 ⇒ 永远触发不了回传。
 * [CONSTRAINT] 容器存在但文本为空时退回整页末 300 字符（旧行为），
 *   保证「有容器但还没渲染出内容」的站点不回归。
 */
function bodySignature(): string {
  const root = latestAssistantRoot()
  const rootText = root ? (root.textContent || '').replace(/\s+/g, ' ').trim() : ''
  const t = rootText || (document.body.textContent || '').replace(/\s+/g, ' ')
  return hash32(t.slice(-300))
}

/**
 * [legacy-plain-removed-v1] 旧的 extractLatestReplyText（把最后一条回复的整段 Markdown 当
 *   plain 文本回传）已删：它唯一的调用点是 listener 的 handleRescan，而契约 §1 要求裸文本
 *   整轮丢弃。需要「最后一条回复的 Markdown」时走 extractReplyMd(latestAssistantRoot())，
 *   且**只**用于读信封，不再用于回传。
 */
