// [replay-buffer-v1] 断线重连的重放缓冲。从 attach-ws.ts 抽出，只为一件事：**能单独测**。
//
// [WHY 抽出] 这段逻辑此前藏在 attach-ws 的闭包里，没有任何用例覆盖。2026-10-19 改造时，
//   把「四个 `!==` 串联」改成「清单 includes」的过程中漏掉了判断行本身 ——
//   于是所有帧（含 headless:state / files:changed 这类高频帧）都会被塞进 30 条上限的缓冲，
//   重放能力被瞬间冲垮。而当时的闸门全绿：`ts/no-unused-vars` 只是 warning，eslint exit 0。
//   ⇒ 高频、低可见、无守卫的过滤逻辑，必须能脱离宿主被断言。

/** 单 sid 最多保留的重放帧数（约最近若干轮回复） */
export const SRV_BUF_MAX = 30
/** 参与重放的 sid 上限（防止 Map 无界增长） */
export const SRV_SID_MAX = 64

/**
 * 可重放的帧类型。
 * [CONSTRAINT] 只放「断了重连还需要看到」的业务帧。加得太宽会让 30 条上限被状态帧冲垮，
 *   加得太窄会让重连后丢内容 —— 两种都表现为「重连后页面不对」，但原因相反。
 * [turn-envelope-v1] 加入块帧：只补 headless:reply 会让前端看到一个「没有内容的 turn」。
 */
export const REPLAYABLE_FRAMES: readonly string[] = [
  'headless:reply',
  'headless:script',
  'headless:summary',
  'headless:new-session-created',
  'ai:block',
  'ai:turn-end',
]

/**
 * 构造一个「往缓冲里塞帧」的函数。
 * [attach-ws-buffer-sid-cap-v1] 达 sid 上限时淘汰最旧 key（Map 保插入序，取首个即最久未新增者），
 *   与 LRU 近义：仍在活跃推送的 sid 每帧都会先 delete 再 set 重新入队尾。
 * [CONSTRAINT] 淘汰只丢「重放能力」，不影响在线会话：会话的浏览器上下文由 pool 持有。
 * @param buf sid → 该 sid 的帧数组（调用方持有，便于在读端直接使用）
 * @returns (sid, payload) => void
 */
export function createBufferOut(buf: Map<string, unknown[]>): (sid: string, payload: unknown) => void {
  return (sid, payload) => {
    if (!sid) return
    // [CONSTRAINT] 缓冲是**旁路**：它绝不能因为载荷形状怪异而抛异常 —— 这条函数在 send 路径上，
    //   抛出来就不只是「没存进重放」，而是「这一帧根本没发出去」。非对象一律静默丢弃。
    if (!payload || typeof payload !== 'object') return
    const t = (payload as { t?: string }).t || ''
    // [CONSTRAINT] 这一行是本模块存在的全部意义：非清单帧一律不入缓冲。
    if (!REPLAYABLE_FRAMES.includes(t)) return
    let arr = buf.get(sid)
    if (!arr) {
      if (buf.size >= SRV_SID_MAX) {
        const oldest = buf.keys().next()
        if (!oldest.done) buf.delete(oldest.value)
      }
      arr = []
      buf.set(sid, arr)
    }
    arr.push(payload)
    if (arr.length > SRV_BUF_MAX) arr.shift()
  }
}
