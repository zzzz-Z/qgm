// @ts-nocheck
// [tampermonkey-ts-rewrite-v1] IIFE 物理切分片段，非独立模块；跨片段符号在单文件检查下不可见。
//   全部片段 TS 化完成、按拼回后的联合视图接线后再移除本 pragma。

/**
 * 回复检测 —— dispatch 的三个输入源：DONE 标记、正文签名、最新回复全文。
 *
 * [CONSTRAINT] 三者在「assistant 容器缺失」时必须一致地**什么都不做**：
 *   新会话首轮「已思考/搜索」阶段没有回复容器，此时整页反推会把侧栏历史会话标题
 *   与用户首条消息（SYSTEM.md 卡）拼成「回复」，表现为连续的噪音文本卡。
 *   这条约束在三个函数里各写一次，是有意为之——任何一个漏掉都会单独产生噪音。
 */

/**
 * 本轮是否出现「首行 = DONE」的回复；命中返回去重标记与全文。
 * [CONSTRAINT] marker 只取前 200 字做 hash（不含长度）：短内容时前 200 字随流式变化，
 *   带上长度会让每帧都成新 marker，同一条 DONE 被推 N 次。
 */
function findNewDone(): { marker: string; text: string } | null {
  const root = latestAssistantRoot()
  if (!root) return null
  // 用 DOM→Markdown 反推而非 textContent：后者会把块级元素粘成一行，首行判据失效
  const summary = extractReplyMd(root)
  if (summary && scanReplyMarks(summary).done > 0) {
    const headMarker = hash32(`done-head|${summary.slice(0, 200)}`)
    if (!seenDoneMarkers.has(headMarker)) {
      return { marker: headMarker, text: summary }
    }
  }
  return null
}

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
 * 最后一条回复的完整 Markdown。
 * [CONSTRAINT] 容器缺失返回空串，**不**退回整页：plain 分支拿到空串就不会推送，
 *   这正是「思考阶段不产生噪音卡」所需要的。
 */
function extractLatestReplyText(): string {
  try {
    const root = latestAssistantRoot()
    if (!root) return ''
    return extractReplyMd(root)
  } catch { return '' }
}
