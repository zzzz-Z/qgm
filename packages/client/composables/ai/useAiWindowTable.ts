import { ref } from 'vue'
import { url } from './useDeepseekUrl'

// ============================================================================
// 活动窗口引用管理 —— postMessage 的目标 window 必须精确，否则跨域无法操作 DOM
// 新窗口覆盖旧引用（简化：只跟最新一个），与油猴侧 window.opener 一一对应
// ============================================================================
// [multi-loop-step3] 窗口表：按 sid 存储；activeWinSid 指向当前激活槽位
const windowTable = new Map<string, { win: Window, url: string }>()
const activeWinSid = ref<string>('default')

/** 获取 Active Win Sid */
export function getActiveWinSid(): string {
  return activeWinSid.value
}
/**
 * 切换激活槽位
 * [CONSTRAINT] 不校验 sid 是否已存在于 windowTable —— 允许先切槽再 openDeepseek 绑定
 */
export function setActiveWinSid(sid: string): void {
  activeWinSid.value = sid
}
// [multi-loop-step7-url] 删除窗口表条目（供 App.vue 删会话时同步清理）
export function removeWindowBySid(sid: string): void {
  windowTable.delete(sid)
}
/**
 * 取 sid 对应的 window 引用
 * [WHY] 页面刷新后内存引用可能失效；此处惰性校验 closed，命中即清理并返回 null
 * [CONSTRAINT] 跨域只允许读 win.closed，读其他属性会抛错
 */
export function getWindowBySid(sid: string): Window | null {
  const entry = windowTable.get(sid)
  if (!entry) return null
  if (entry.win.closed) {
    windowTable.delete(sid)
    return null
  }
  return entry.win
}
/** 列出所有仍存活的窗口 */
export function listWindows(): Array<{ sid: string, url: string }> {
  const out: Array<{ sid: string, url: string }> = []
  for (const [sid, v] of windowTable) {
    if (!v.win.closed) out.push({ sid, url: v.url })
    else windowTable.delete(sid)
  }
  return out
}
/** 获取 Active Win */
export function getActiveWin(): Window | null {
  return getWindowBySid(activeWinSid.value)
}
/**
 * 绑定/解绑当前激活槽位的 window 引用
 * [CONSTRAINT] win=null 时从表里删除对应条目，等价于解绑
 */
export function setActiveWin(win: Window | null): void {
  const sid = activeWinSid.value
  if (!win) { windowTable.delete(sid); return }
  windowTable.set(sid, { win, url: url.value })
}
// [split-send-v1] 供 useAiWindow 写回 windowTable（页面刷新后按 name 找回窗口时用）
export function setWindowEntry(sid: string, entry: { win: Window, url: string }): void {
  windowTable.set(sid, entry)
}

/** 计算 postMessage 的目标 origin：从当前 url.value 提取 protocol://host */
export function targetOrigin(): string {
  try {
    const u = new URL(url.value)
    return `${u.protocol}//${u.host}`
  } catch {
    // 退化：origin 未知则不发，避免用 '*'（违反 v6 §3.4 安全约束）
    return ''
  }
}
