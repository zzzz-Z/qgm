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

// 活动窗口引用管理 —— postMessage 的目标 window 必须精确，否则跨域无法操作 DOM
// 新窗口覆盖旧引用（简化：只跟最新一个），与油猴侧 window.opener 一一对应
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
// [win-opened-marker-v1] 窗口「已打开」标记的持久化 + 探测恢复
// [WHY] windowTable 是内存 Map，刷新后清空；站点列表刷新即显示「未打开」，
//   即便浏览器里那个 AI 站点窗口真的还开着。跨域窗口无法直接读存活状态，
//   只能靠「标记 + window.open(name) 探测」双轨推断。
// [CONSTRAINT] 探测只在已标记的 sid 上调用（避免无手势时弹窗噪音）；
//   open 到跨域会抛错（= 已有窗口），open 到同源 about:blank 说明新建了（立即 close）。
// [CHANGE-IMPACT] openSite 成功后应调 markWindowOpened(sid, true)；dismiss/探测失败调 false。
const WIN_OPENED_KEY = '__ai_win_opened_sids'

function readOpenedSet(): Set<string> {
  try {
    if (typeof sessionStorage === 'undefined') return new Set()
    const raw = sessionStorage.getItem(WIN_OPENED_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw)
    return new Set(Array.isArray(arr) ? arr.map(String) : [])
  } catch { return new Set() }
}

function writeOpenedSet(s: Set<string>): void {
  try {
    if (typeof sessionStorage === 'undefined') return
    sessionStorage.setItem(WIN_OPENED_KEY, JSON.stringify([...s]))
  } catch { /* ignore */ }
}

/** 标记某 sid 窗口是否处于「已打开」状态；由 openSite / dismiss / 探测 三处调用 */
export function markWindowOpened(sid: string, opened: boolean): void {
  const s = readOpenedSet()
  if (opened) s.add(sid)
  else s.delete(sid)
  writeOpenedSet(s)
}

/** 读取某 sid 是否处于「已打开」（仅查标记，不做真实探测） */
export function isWindowMarkedOpened(sid: string): boolean {
  return readOpenedSet().has(sid)
}

/** 站点窗口的 name（同名 window.open 复用同一窗口，避免同 sid 多窗口） */
export function winNameOf(sid: string): string {
  return sid === 'default' ? 'ai-runner-site' : `ai-runner-site-${sid}`
}

/**
 * 探测某 sid 对应的 AI 站点窗口是否真的存在
 * [WHY] 页面刷新后内存引用丢失；`window.open('', name)` 是唯一可靠的跨刷新探测手段。
 * [CONSTRAINT] 探测会尝试 open —— 若目标不存在会新建空白同源窗口，须立即 close 回收；
 *   若目标存在（跨域），open 返回该引用但读 location 会抛 DOMException，据此区分两种情形。
 * [CHANGE-IMPACT] 命中时写回 windowTable（供 copyAndFill 免寻找窗口）；未命中时清标记。
 * @returns true 表示窗口真实存在（已写回表）；false 表示不存在（已清标记）
 */
export function probeWindowBySid(sid: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    const win = window.open('', winNameOf(sid))
    if (!win || win === window) { markWindowOpened(sid, false); return false }
    try {
      // 同源 about:blank = 新开的空白窗口（原窗口不存在）→ 立即关闭 + 清标记
      if (win.location && win.location.href === 'about:blank') {
        win.close()
        markWindowOpened(sid, false)
        return false
      }
    } catch {
      // 跨域读 location 抛错 = 已有跨域窗口存在 → 保留引用
    }
    setWindowEntry(sid, { win, url: url.value })
    return true
  } catch {
    markWindowOpened(sid, false)
    return false
  }
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
// [win-sid-namespace-v1] 站点窗口槽位 sid 的唯一命名来源
// [WHY] AiWindowList 用 win_<modelId> 判「是否已打开」，但 App.vue 开窗时没传 sid →
//   登记到 default 槽位 → 两套名字从不重合 → 站点列表恒显示未打开。
//   抽到此处后，所有开窗路径（App.vue onOpenAiWin / onNewSession / 站点列表点击）都读这一个函数。
// [CONSTRAINT] 前缀 `win_` 不可改：与已落盘的 windowTable 键、油猴 hash #sid= 兼容。
export function winSidOf(modelId: string): string {
  return `win_${modelId}`
}
// [win-recover-blank-guard-v1] 判一个窗口引用是否是「open('', name) 新建的同源空白页」。
//   WHY: 目标窗口不存在时 window.open('', name) 会**新建** about:blank 同源空白页，
//     该引用 closed===false 且 location 可读（同源），极易被误当「找回的 AI 窗口」——
//     postMessage(fill, 站点 origin) 帧会落到空白页被浏览器静默丢弃 → 日志假 ok:true、
//     UI 假「已发送」、实际收不到脚本（2026-10-07 用户实测的「发不出去」根因）。
//   [CONSTRAINT] 跨域读 location.href 会抛 DOMException = 真窗口，返回 false；
//     只有能读到且恰为 about:blank 才判 true。
//   [CHANGE-IMPACT] probeWindowBySid 与 copyAndFill 恢复分支共用此判据，改这里两处同步。
export function isBlankRef(win: Window | null): boolean {
  if (!win) return false
  try { return win.location.href === 'about:blank' } catch { return false }
}
