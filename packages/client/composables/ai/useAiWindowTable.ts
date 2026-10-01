import { ref } from 'vue'
import { url } from './useAiSite'

// [ai-window-list-v1] 响应式信号：Map 增删触发 UI 刷新
// [WHY] windowTable 是普通 Map 非 ref，Map.set/delete 不触发 Vue 依赖；
//       加一个单调递增的 tick ref 作为刷新信号，组件 computed 里访问即可关联
// [CONSTRAINT] bump 只在 mutation 路径调用；不改 Map 结构，仅通知
// [CHANGE-IMPACT] AiWindowList.vue 消费此信号；去掉后列表不随窗口开关更新
/** 响应式刷新信号；任何窗口表 mutation 都 +1 */
export const windowsTick = ref(0)
/** 通知所有消费方：窗口表已变化 */
function bumpWindows(): void { windowsTick.value++ }

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
 * [CONSTRAINT] 不校验 sid 是否已存在于 windowTable —— 允许先切槽再 openSite 绑定
 */
export function setActiveWinSid(sid: string): void {
  activeWinSid.value = sid
  bumpWindows()
}
// [multi-loop-step7-url] 删除窗口表条目（供 App.vue 删会话时同步清理）
export function removeWindowBySid(sid: string): void {
  windowTable.delete(sid)
  bumpWindows()
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
    bumpWindows()
    return null
  }
  return entry.win
}
/** 列出所有仍存活的窗口 */
export function listWindows(): Array<{ sid: string, url: string }> {
  const out: Array<{ sid: string, url: string }> = []
  for (const [sid, v] of windowTable) {
    if (!v.win.closed) { out.push({ sid, url: v.url })
    }
    else { windowTable.delete(sid); bumpWindows() }
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
  if (!win) { windowTable.delete(sid); bumpWindows(); return }
  windowTable.set(sid, { win, url: url.value })
  bumpWindows()
}
// [split-send-v1] 供 useAiWindow 写回 windowTable（页面刷新后按 name 找回窗口时用）
export function setWindowEntry(sid: string, entry: { win: Window, url: string }): void {
  windowTable.set(sid, entry)
  bumpWindows()
}

/**
 * 计算指定 sid 的 postMessage 目标 origin
 * [WHY] 多站点并存时不能读全局 url.value（openSite 不改它）；
 *       每个 sid 在 windowTable 内已存自己的 url，从那里提取才是正确的 origin
 * [CONSTRAINT] sid 不存在 / url 解析失败 → 返回空串（调用方跳过发送，不用 '*' 兜底）
 * [CHANGE-IMPACT] useAiWindowSend 全部 send*To 依赖本函数计算 origin；
 *                与旧 targetOrigin() 语义一致，仅改为按 sid 取 url
 * @param sid 目标窗口 sid
 */
export function targetOriginFor(sid: string): string {
  const entry = windowTable.get(sid)
  if (!entry) return ''
  try {
    const u = new URL(entry.url)
    return `${u.protocol}//${u.host}`
  } catch {
    return ''
  }
}

/**
 * 计算 postMessage 的目标 origin（当前激活槽位）
 * [CONSTRAINT] 保留旧 API 供 useAiWindow / 测试调用；内部转为 targetOriginFor(activeWinSid)
 */
export function targetOrigin(): string {
  return targetOriginFor(activeWinSid.value)
}
