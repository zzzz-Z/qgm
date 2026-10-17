// @ts-nocheck
// [tampermonkey-ts-rewrite-v1] IIFE 物理切分片段，非独立模块；跨片段符号在单文件检查下不可见。
//   全部片段 TS 化完成、按拼回后的联合视图接线后再移除本 pragma。

/**
 * 控制动作 —— 打断生成、开新会话。
 *
 * [WHY] 这两类动作误触发的代价很高：错误地打断会丢掉正在生成的内容，
 *   错误地跳转会丢掉整个会话。故每一级回退都只在「上一步确定没生效」时才启用。
 */

/**
 * 点击停止生成。
 * [WHY] 纯文案匹配脆弱：站点改版换图标/文案后即静默失效，AI 继续流式生成。
 *   故在按钮未命中时补一个 Esc 键盘事件兜底（多数站点把它绑到中断）。
 * [CONSTRAINT] 结构化兜底（圆形主按钮）只在此处启用：此刻输入区的圆钮必然是停止键
 *   （发送键已让位），不会误伤 generating gate 的判定。
 * @returns 是否点到按钮（false 表示走了 Esc 兜底或彻底失败，仅用于日志）
 */
function clickStopGenerating(): boolean {
  try {
    const btn = findStopGeneratingBtn() || findStopGeneratingBtnStructural()
    if (btn && !(btn as HTMLButtonElement).disabled) {
      btn.click()
      return true
    }
  } catch { /* 按钮定位异常：继续走 Esc 兜底 */ }

  try {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      keyCode: 27,
      which: 27,
      bubbles: true,
      cancelable: true,
    }))
  } catch { /* 键盘事件构造失败：彻底失败，返回 false */ }
  return false
}

/**
 * 定位「新建对话」按钮。
 * [CONSTRAINT] 文案候选覆盖中英文主要变体；用 find 而非 querySelector，
 *   是因为文案可能分布在 aria-label / title / textContent 三处，需逐个拼接后再匹配。
 */
function findNewChatButton(): HTMLElement | null {
  const all = Array.from(document.querySelectorAll('button, a, [role="button"]'))
  const found = all.find((el) => {
    const lbl = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('data-testid') || ''}`
    return /新建对话|新对话|新建聊天|新建会话|开启新对话|new\s*chat|new\s*conversation/i.test(lbl)
  })
  return (found as HTMLElement) || null
}

/**
 * 开新会话。
 * [WHY] 触顶后继续在原会话提问不可能有产出，必须换会话才能继续。
 *   两级回退：先点站点自己的「新建对话」，找不到才跳转站点根路径（多数站点根路径即新会话）。
 * [CONSTRAINT] 跳转分支必须判断「当前不在根路径」：已在根路径还赋值 location.href
 *   会触发一次无意义的整页重载，油猴实例被重建、全部运行态丢失。
 * [CONSTRAINT] 不搬运 summary：交接内容由工作台侧负责，脚本只做「换会话」这一件事。
 */
function clickNewSession(): boolean {
  const btn = findNewChatButton()
  if (btn && !(btn as HTMLButtonElement).disabled) {
    try { btn.click(); return true } catch { /* 点击失败：落跳转兜底 */ }
  }
  const url = `${location.origin}/`
  if (location.href !== url && location.pathname !== '/') {
    location.href = url
    return true
  }
  return false
}
