// [arrive-log-v1] /arrive-log —— 「页面把脚本推到前端」这一跳的落盘探针。
//
// [WHY] 脚本从 AI 回复到执行之间有一段**完全无落盘**的区间：
//   页面侧推送 → 前端收件箱（模块级 ref，无持久化）→ 执行分流 → /run。
//   这段里任何一次静默丢弃（去重命中 / rescan / 刷新冷静期 / 停止后窗口 / 轮内合并窗抑制残余块）
//   在服务端都表现为「什么都没发生」：reject.jsonl 不记（压根没进 /run 流水线）、
//   当日运行日志不记（压根没执行）、而「脚本到达」播报又已在 [script-toast-removed-v1] 删除。
//   于是故障现场只剩「左边没有脚本信息」，**无法区分「页面没推」与「推了被前端静默吞掉」**
//   （2026-10-10 上午两次「脚本没回传」排查都卡在这里，最后一跳靠猜）。
//   本通道把「到达 + 最终命中哪条出口」变成可数事实：`reason` 即可定位是哪道闸门吃掉的。
//
// [CONSTRAINT] **只加日志，不改行为**：本路由不参与任何业务判定，永远返回 200；
//   非 JSON / 缺字段 / 字段类型离谱都只影响这一条的字段质量，绝不产生错误语义给调用方。
// [CONSTRAINT] 入参不可信（与 send 同：唯一由浏览器内容驱动的日志通道）⇒ 落盘行长必须有界：
//   所有字符串字段经 buildArriveEntry 单行化 + 限长，故无论请求体多大，**每行体积恒定有界**。
import { Hono } from 'hono'
import { writeChannelLog } from '../state/snapshot.js'
import { toSingleLine } from './control-log.js'

/** 脚本到达的留痕条目（由前端经 `/arrive-log` 上报） */
export interface ArriveLogEntry {
  channel: 'arrive'
  /** 会话 id（页面通道形如 `sess-tab-*` / `win_*`，空串即未知来源） */
  sid: string
  /** 脚本语言：js / cjs / bash */
  lang: string
  /** 最终出口：run（已排入执行）/ dedup（去重命中）/ rescan / refresh-guard / stopped-window */
  reason: string
  /** 脚本里的 @desc 行（单行化，限 160）——肉眼判「是哪一条脚本」，不落正文 */
  desc: string
  /** 脚本行数 */
  lines: number
  /** 脚本字节数 */
  bytes: number
}

/**
 * 组装到达留痕条目（纯函数，无 IO，便于值级单测）
 * [CONSTRAINT] 所有字符串字段单行化 + 限长：jsonl 一行一条，正文换行会破坏结构；
 *   且入参必须假定是任意字节串（不信任长度与类型）。
 * @param body `/arrive-log` 的请求体（字段全部可选，缺省即用安全默认值）
 */
export function buildArriveEntry(body: Record<string, unknown>): ArriveLogEntry {
  return {
    channel: 'arrive',
    sid: toSingleLine(String(body.sid ?? ''), 120),
    lang: toSingleLine(String(body.lang ?? ''), 16),
    reason: toSingleLine(String(body.reason ?? ''), 40),
    desc: toSingleLine(String(body.desc ?? ''), 160),
    lines: Math.max(0, Math.trunc(Number(body.lines) || 0)),
    bytes: Math.max(0, Math.trunc(Number(body.bytes) || 0)),
  }
}

/** arrive-log 路由的 Hono 实例 */
export const arriveLogHono = new Hono()

// 到达上报（fire-and-forget，调用方不读响应体）
arriveLogHono.post('/arrive-log', async (c) => {
  let body: Record<string, unknown> = {}
  // 空体 / 非 JSON 按空对象处理：留痕通道宁可少字段，也不该给调用方制造错误语义
  try { body = (await c.req.json()) as Record<string, unknown> } catch { /* ignore */ }
  writeChannelLog('arrive', buildArriveEntry(body))
  return c.json({ ok: true })
})
