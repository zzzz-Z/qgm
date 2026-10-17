// @ts-nocheck
// [tampermonkey-ts-rewrite-v1] IIFE 物理切分片段，非独立模块；跨片段符号在单文件检查下不可见。
//   全部片段 TS 化完成、按拼回后的联合视图接线后再移除本 pragma。

/**
 * 启动序列 —— 所有函数定义完成后的最后一段，负责把「会话身份上报」跑起来。
 *
 * [CONSTRAINT] 本文件必须排在拼接顺序的最后：这里直接调用 send()，
 *   若排在 session.ts 之前，函数尚未定义（IIFE 内函数声明会提升，但常量与
 *   已执行的初始化语句不会），首发上报会拿到空 ID。
 * [CONSTRAINT] 这里只负责**会话身份**通道；回复回传的观察器在 observer.ts 里自行启动。
 *   两条通道彼此独立：身份通道丢了只影响归窗，回复通道丢了才影响脚本送达。
 */

// 首次上报：脚本注入时若 URL 已含会话 ID，立刻告知工作台，避免等到用户交互才归窗
send()

/**
 * URL 轮询兜底。
 * [WHY] SPA 站点切会话常只改 history 不改 hash，popstate 也不会触发
 *   （pushState 不产生事件）。轮询是唯一能覆盖全部路由实现的手段。
 * [CONSTRAINT] 500ms：远低于人类的「切会话→期望看到反应」容忍度，
 *   又足够稀疏，不会给主线程添负担。
 */
let lastHref = location.href
setInterval(() => {
  if (location.href !== lastHref) {
    lastHref = location.href
    send()
  }
}, 500)

/**
 * DOM 观察器（会话身份通道）。
 * [WHY] 部分站点在会话切换时先改 DOM 再改 URL，或干脆不改 URL（同 URL 多会话）。
 *   DOM 变动是比 URL 更早、更全的信号。
 * [CONSTRAINT] 800ms 防抖：会话切换时站点往往连续重排，逐帧 send 只是重复上报同一个值。
 */
let domTimer: ReturnType<typeof setTimeout> | null = null
const sessionObserver = new MutationObserver(() => {
  if (domTimer) clearTimeout(domTimer)
  domTimer = setTimeout(send, 800)
})
sessionObserver.observe(document.body, { childList: true, subtree: true, characterData: true })

/**
 * body 存活检查。
 * [WHY] SPA 整页替换 body 时，原 observer 绑在已脱离文档的旧节点上，从此静默失效。
 *   重建 body 后必须重挂，否则会话身份通道永久哑掉。
 * [CONSTRAINT] 3 秒一次：这是兜底而非主路径，频率过高没有收益。
 */
setInterval(() => {
  if (!document.body || !document.body.isConnected) return
  try {
    sessionObserver.observe(document.body, { childList: true, subtree: true, characterData: true })
  } catch { /* body 正在替换中：下次再试 */ }
}, 3000)

// 前进/后退与 hash 变更同样会切换会话，且这两个事件比轮询更及时
window.addEventListener('popstate', send)
window.addEventListener('hashchange', send)
