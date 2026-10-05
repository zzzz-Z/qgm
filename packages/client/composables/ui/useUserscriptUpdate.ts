// [userscript-update-v1] 工作台「安装 / 更新油猴脚本」入口。
// [WHY] 油猴脚本改一次就要用户自己去 Tampermonkey 点一次更新，而脚本本体与分发端点都在本机 ——
//   工作台完全能把这个动作收成一次点击：拉元信息 → 打开分发端点 URL → Tampermonkey 拦截弹更新页。
// [CONSTRAINT] 判定逻辑抽成纯函数 evaluateUserscriptInfo：node 环境（vitest，无 window / toast）
//   可直接单测分支，不必 mock 浏览器。
// [CHANGE-IMPACT] 被 App.vue header 的按钮消费；依赖服务端 GET /__ai/userscript/info 的字段契约。
import { useToast } from './useToast'
import { TOAST_LONGEST, TOAST_MEDIUM } from '../../utils/toast-durations'

/** 服务端 GET /userscript/info 的响应（字段与 packages/core/src/routes/userscript.ts 一一对应） */
export interface UserscriptInfo {
  ok?: boolean
  exists?: boolean
  /** 脚本相对仓库根路径，仅用于提示文案 */
  file?: string
  /** 脚本 @version；缺失为 null */
  version?: string | null
  bytes?: number
  mtimeMs?: number
  servePort?: number
  /** 本地分发端点是否在监听 */
  serveAlive?: boolean
  /** 分发端点上的 .user.js 地址（Tampermonkey 的安装/更新入口） */
  updateUrl?: string
  /** 分发端点的引导页地址 */
  pageUrl?: string
  error?: string
}

/** 判定结果：open=可打开更新页；warn=前置条件缺失但非错误；error=拿不到有效信息 */
export type UserscriptAction = 'open' | 'warn' | 'error'

/** 一次「更新油猴脚本」的判定 */
export interface UserscriptDecision {
  action: UserscriptAction
  message: string
  /** 仅 action==='open' 时给出 */
  url?: string
}

/**
 * 由服务端元信息判定下一步动作
 * [WHY] 把「三态分流」独立成纯函数：任一分支漏掉都会让用户看到不含原因的成功提示。
 * [CONSTRAINT] 分层顺序不可调换：先判响应有效性 → 再判文件存在 → 再判端点存活 → 最后取地址。
 *   端点未起时给 warn 而非 error：这不是故障，是「先启动分发端点」这一可执行动作。
 * @param info 服务端响应；网络失败时传 null
 * @returns 动作 + 面向用户的文案
 */
export function evaluateUserscriptInfo(info: UserscriptInfo | null): UserscriptDecision {
  if (!info || info.ok !== true) {
    return { action: 'error', message: `读取油猴脚本信息失败：${info?.error || '服务端未返回有效响应'}` }
  }
  if (!info.exists) {
    return { action: 'error', message: `未找到油猴脚本文件（${info.file || 'scripts/tampermonkey-session-id.user.js'}）` }
  }
  if (!info.serveAlive) {
    return {
      action: 'warn',
      message: `分发端点未启动（127.0.0.1:${info.servePort ?? 5178}），请先启动它再更新：node .ai-runner/tmp/serve-userscript.mjs`,
    }
  }
  const url = info.updateUrl || ''
  if (!url) return { action: 'error', message: '服务端未返回更新地址' }
  return {
    action: 'open',
    url,
    message: `已打开油猴脚本更新页（v${info.version || '未知'}），Tampermonkey 将弹出安装 / 更新确认`,
  }
}

/**
 * 拉取元信息并打开分发端点，完成「安装 / 更新油猴脚本」
 * [CONSTRAINT] [popup-gesture-v1] 必须**先同步开窗**再 await：Chrome 把 await 之后调用的
 *   window.open 视为非用户手势弹窗直接静默拦截；先占一个 about:blank 标签页，拿到地址后改写其
 *   location 即可绕开该限制。判定为 warn / error 时须把占位的空白页关掉，避免留下僵尸标签。
 * @returns 最终判定（同时以 toast 呈现），便于调用方/测试断言
 */
export async function updateUserscript(): Promise<UserscriptDecision> {
  const { toast } = useToast()
  const win = window.open('about:blank', '_blank')

  let decision: UserscriptDecision
  try {
    const res = await fetch('/__ai/userscript/info', { headers: { accept: 'application/json' }, cache: 'no-store' })
    decision = evaluateUserscriptInfo(await res.json() as UserscriptInfo)
  } catch (e) {
    decision = { action: 'error', message: `请求油猴脚本信息失败：${String(e)}` }
  }

  if (decision.action === 'open' && decision.url) {
    if (win) {
      win.location.href = decision.url
    } else {
      decision = { action: 'warn', message: '打开失败：可能被浏览器拦截，请允许本页弹出新窗口后重试' }
    }
  } else {
    try { win?.close() } catch { /* 占位页可能已被用户关闭，忽略 */ }
  }

  const type = decision.action === 'open' ? 'success' : decision.action === 'warn' ? 'warn' : 'error'
  toast(decision.message, type, decision.action === 'error' ? TOAST_MEDIUM : TOAST_LONGEST)
  return decision
}
