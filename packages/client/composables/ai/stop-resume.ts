// [stop-resume-v1] 「停止 → 判定 → 续推」职责链的单一入口。
//
// [WHY 聚合而非散落] 这条链天然横跨两处调用点：
//   ① 出站：sendStop（用户主动点停止，useAiWindowSend.ts）
//   ② 入站：handleAiReply 的 stopped 分支（useAiReplyHandlers.ts）
//   若把标记放一处、判定放另一处、续推放第三处，三处各自演化必然漂移。
//   聚到一个模块后：标记的写入/消费、续推的计数/上限、TTL 清理全在同处，
//   调用方只依赖两个语义化函数（markUserStop / decideOnStopped），不碰内部状态。
//
// [职责边界] 本模块只管「要不要续推」的决策与状态；真正的发送动作由调用方执行
//   （本模块不 import useAiWindow，避免循环依赖，也保持单一职责）。

/** 用户主动停止标记：sid → 时间戳 */
const userStopAtBySid = new Map<string, number>()
/** 续推计数：sid → 已续推次数（达到上限后不再续推） */
const resumeCountBySid = new Map<string, number>()

/** 标记 TTL：防 sendStop 后油猴未触发（站点改版找不到按钮）导致的标记残留 */
const USER_STOP_TTL_MS = 60_000
/** 单次停止最多自动续推次数：超过说明非偶发中断，交由用户处理 */
export const MAX_AUTO_RESUME = 2

/** 正在自动续推的 sid 集合（防「续推→sendFill→resetResumeCount」把配额清掉） */
const autoResumingSids = new Set<string>()

/** 自动续推开始前调用（进入临界区） */
export function beginAutoResume(sid: string): void { if (sid) autoResumingSids.add(sid) }
/** 自动续推结束后调用（离开临界区，幂等） */
export function endAutoResume(sid: string): void { if (sid) autoResumingSids.delete(sid) }
/** 该 sid 是否正在自动续推（sendFill 据此决定是否清配额） */
export function isAutoResuming(sid: string): boolean { return autoResumingSids.has(sid) }

/** 用户主动停止时调用（sendStop 调用点） */
export function markUserStop(sid: string): void {
  if (!sid) return
  const now = Date.now()
  userStopAtBySid.set(sid, now)
  // TTL 清理：Map 很小，每次 mark 扫一遍即可
  for (const [k, v] of userStopAtBySid) { if (now - v > USER_STOP_TTL_MS) userStopAtBySid.delete(k)
  }
}

/**
 * stopped 到达时的续推决策（单一入口）。
 * @returns { resume: boolean } — resume=true 时调用方应发「继续」；false 表示不续推
 *
 * [决策顺序] 用户主动停 > 达上限 > 可续推。
 *   用户主动停：消费一次标记后**立即返回 false**——不占用续推配额（用户的手动停止不该消耗自动重试预算）。
 *   达上限：返回 false，由调用方决定是否提示用户。
 */
export function decideOnStopped(sid: string): { resume: boolean, reason: 'user-stop' | 'max-reached' | 'auto' } {
  // [resume-empty-sid-v1] 空 sid 不再当成「用户主动停止」。
  // [WHY] 原实现 `if (!sid) return { resume: false, reason: 'user-stop' }` 把「拿不到 sid」
  //   与「用户明确要停」混为一谈 ⇒ 探针命中但续推被静默跳过（2026-10-18 实测：
  //   payload.sessionId 取自 URL hash `#sid=`，DeepSeek 无此 hash ⇒ 恒为空）。
  // [CONSTRAINT] 空 sid 时无 user-stop 记录可比，保守方向是「允许续推」——
  //   续推的默认意图是帮用户恢复，真用户停过则 markUserStop 会带上窗口 sid 命中下面的分支。
  if (!sid) return { resume: true, reason: 'auto' }
  // ① 用户主动停？
  const t = userStopAtBySid.get(sid)
  if (t !== undefined) {
    userStopAtBySid.delete(sid)
    // TTL 内视为有效配对；过期则当没发过（理论不可达，因 markUserStop 会清过期项）
    if (Date.now() - t <= USER_STOP_TTL_MS) return { resume: false, reason: 'user-stop' }
  }
  // ② 达上限？
  const n = resumeCountBySid.get(sid) || 0
  if (n >= MAX_AUTO_RESUME) return { resume: false, reason: 'max-reached' }
  // ③ 可续推
  resumeCountBySid.set(sid, n + 1)
  return { resume: true, reason: 'auto' }
}

/**
 * [resume-watchdog-v1] 续推看门狗超时后的重试决策（单一入口）。
 * [WHY] 续推发出后 45s 无任何真实回复，多半是页面探针静默失效或回复被吞；
 *   与其只提示用户手动发，不如在配额内自动再试一次——但必须两条硬约束：
 *   ① 用户最近主动停过 ⇒ 绝不自动重发（尊重意图，且主动停不该被机器覆盖）；
 *   ② 总重试次数仍受 MAX_AUTO_RESUME 约束（与 stopped 决策共用同一计数器，防无限重试）。
 * [CONSTRAINT] 只读用户停止标记（不像 decideOnStopped 那样消费）——该标记仍须留给
 *   真正的 stopped 到达时判定，否则自动重试会把「用户停过」这一事实抹掉。
 */
export function decideOnResumeTimeout(sid: string): { retry: boolean, reason: 'user-stop' | 'max-reached' | 'auto' } {
  if (!sid) return { retry: false, reason: 'user-stop' }
  const t = userStopAtBySid.get(sid)
  if (t !== undefined) {
    if (Date.now() - t <= USER_STOP_TTL_MS) return { retry: false, reason: 'user-stop' }
    userStopAtBySid.delete(sid)
  }
  const n = resumeCountBySid.get(sid) || 0
  if (n >= MAX_AUTO_RESUME) return { retry: false, reason: 'max-reached' }
  resumeCountBySid.set(sid, n + 1)
  return { retry: true, reason: 'auto' }
}

/** 新一轮 fill/rotate 时重置续推计数（新提问不该继承上一轮的配额） */
export function resetResumeCount(sid: string): void {
  if (sid) resumeCountBySid.delete(sid)
}

/** [测试用] 清空全部状态 */
export function _resetAll(): void {
  userStopAtBySid.clear()
  resumeCountBySid.clear()
  autoResumingSids.clear()
}
/** [测试用] 直接写入带时间戳的标记（验证 TTL 行为） */
export function _setUserStopAt(sid: string, ts: number): void { userStopAtBySid.set(sid, ts) }
/** [测试用] 读取当前续推计数 */
export function _getResumeCount(sid: string): number { return resumeCountBySid.get(sid) || 0 }
