// @ts-nocheck
// [tampermonkey-ts-rewrite-v1] IIFE 物理切分片段，非独立模块；跨片段符号在单文件检查下不可见。
//   全部片段 TS 化完成、按拼回后的联合视图接线后再移除本 pragma。

/**
 * 回复观察 —— 什么时候该跑一次 classifyAndPost。
 *
 * 三条唤醒通道，缺一都会让回传卡住：
 *   ① childList / characterData：AI 逐字输出时持续触发（350ms 防抖后归并）。
 *   ② attributes（disabled / aria-label / data-state）：「停止生成」按钮变灰/消失
 *      往往不伴随子节点变化，纯属性变更，仅靠 ① 收不到。
 *   ③ 800ms 空转轮询：回复渲染完成后 DOM 完全静止，若脚本块因任何原因
 *      （闭合门延迟 / 生成中门 / 多块续推）尚未推送，① ② 都不会再触发。
 *
 * [WHY] 通道 ③ 是实测补出来的：用户滚动一下页面就立刻收到 → 滚动引发的 DOM 变动才是唤醒源。
 *   无头通道是 800ms 轮询，天然无此症；本通道对齐该频率。
 * [CONSTRAINT] attributeFilter 刻意不含 'class'：流式光标动画下 class 变更极高频，
 *   会制造 observer 回调风暴。停止按钮的态变走 disabled / aria-label / data-state 已足够覆盖。
 */

const replyObserver = new MutationObserver(() => {
  if (observerDebounce) clearTimeout(observerDebounce)
  observerDebounce = setTimeout(() => {
    observerDebounce = null
    classifyAndPost()
  }, 350)
})

/**
 * 观察器是否已挂上。
 * [WHY] stop 分支要 disconnect（防旧回复重放），下次 fill/rotate 前必须能重挂；
 *   用标志位而非 try/catch 探活，避免重复 observe 造成的隐性叠加。
 */
let _replyObserving = false

/**
 * 重挂观察器（幂等）。
 * [CONSTRAINT] 挂在 document.body 上：body 在 document-idle 时已就绪，
 *   但站点可能整页替换 body，故外层还有 3 秒存活检查兜底（见 session.ts 的 send 循环）。
 */
function resumeReplyObserver(): void {
  if (_replyObserving) return
  try {
    replyObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['disabled', 'aria-label', 'data-state'],
    })
    _replyObserving = true
  } catch { /* body 未就绪：下次 fill/rotate 再试 */ }
}

/** 断开观察器并复位标志；stop 分支调用，与 resumeReplyObserver 成对 */
function pauseReplyObserver(): void {
  try { replyObserver.disconnect() } catch { /* 未挂载时 disconnect 无副作用 */ }
  _replyObserving = false
}

resumeReplyObserver()

/**
 * 空转唤醒轮询。
 * [CONSTRAINT] 三个前置条件均为「不该跑」的短路，任一命中即跳过：
 *   后台标签页（document.hidden）不跑 —— 后台定时器被节流，跑了也没意义；
 *   防抖在途时不跑 —— 避免与 350ms 防抖抢同一轮；
 *   无 assistant 容器不跑 —— 此时变化只可能是思考面板抖动，classifyAndPost 也会自行返回。
 *   classifyAndPost 自身以 seenHashes / lastBodySig 幂等，即便误唤醒也不会重复推送。
 */
// [idle-wake-poll-v1] 空转唤醒兜底：DOM 静止后 observer 不再触发，轮询保证未推送的块不滞留
setInterval(() => {
  try {
    if (typeof document !== 'undefined' && document.hidden) return
    if (observerDebounce) return
    if (!latestAssistantRoot()) return
    classifyAndPost()
  } catch { /* 页面导航/关闭期间的 DOM 异常：本轮放弃 */ }
}, 800)
