const replyObserver = new MutationObserver(() => {
  if (observerDebounce) clearTimeout(observerDebounce)
  observerDebounce = setTimeout(() => {
    observerDebounce = null
    classifyAndPost()
  }, 350)
})

// [stop-v2] 监听生命周期标志 + 重挂入口
// [WHY] stop 需 disconnect 防止旧回复重放；下次 fill/rotate 前须能恢复监听
// [CONSTRAINT] 声明顺序固定在 replyObserver 之后，避免 no-use-before-define
// [CHANGE-IMPACT] 被 stop / fill / rotate 三个分支引用，改此处必须同步改三个触发点
let _replyObserving = false
function resumeReplyObserver() {
  if (_replyObserving) return
  try {
    // [wake-attrs-v1] 追加 attributes 监听：使「停止生成」按钮的态变（class/disabled/aria-label/data-state）
    //   也能唤醒 classifyAndPost，作为「生成结束」的兜底唤醒源（与 [generating-gate-v2] 互补）。
    //   [WHY] 仅 childList/characterData 时，按钮消失/置灰这类纯属性变更无法触发 observer，
    //   若又逢 DOM 静止就只剩用户滚动才能唤醒（2026-10-09 实测：回传延迟 54~65s，滚动后秒推）。
    // [wake-attrs-v2] 给 observer 加 attributes 监听，让「停止生成」按钮的态变也能唤醒回传。
    //   attributeFilter 刻意不含 'class'：流式渲染/光标动画下 class 变更极高频，会制造 observer
    //   回调风暴；停止生成按钮的态变通常走 disabled / aria-label / data-state，这三个足够覆盖，
    //   且变更频次低，350ms 防抖 + 单飞即可挡住推送风暴（[generating-gate-v2] 单飞自检兜底）。
    replyObserver.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'aria-label', 'data-state'] })
    _replyObserving = true
  } catch { /* body 未就绪，下次 fill/rotate 再试 */ }
}
resumeReplyObserver()
// [idle-wake-poll-v1] 空转唤醒兜底：MutationObserver 只在 DOM 变动时唤醒，
//   回复渲染完成后（流式光标移除 / 高亮完成 / 操作条挂载）DOM 静止 ⇒ 若脚本块因任何原因
//   尚未推送（闭合门延迟 / 生成中门 / 多块续推），observer 永不触发，块永久滞留
//   （2026-10-11 用户实测：滚动一下页面即收到 → 滚动引发的 DOM 变动唤醒）。
//   [WHY] headless 侧 startReplyPoll 是 800ms 轮询天然无此症；本补丁对齐该频率。
//   [CONSTRAINT] 后台标签页（document.hidden）不跑；无 assistant 容器不跑；observer 防抖在途时不跑
//     （避免与 350ms 防抖抢），三条件均不满足才调用 classifyAndPost。classifyAndPost 自身
//     以 seenHashes + lastBodySig 幂等，即便误唤醒也不会重复推送。
//   [CHANGE-IMPACT] 若去掉本段，油猴通道在 DOM 静止后完全依赖用户交互（滚动 / 点击）唤醒。
setInterval(() => {
  try {
    if (typeof document !== 'undefined' && document.hidden) return
    if (observerDebounce) return
    if (!latestAssistantRoot()) return
    classifyAndPost()
  } catch { /* swallow: 页面导航/关闭时忽略 */ }
}, 800)
