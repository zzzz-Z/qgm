// [send-trace-v1] /send-log 路由：页面通道每次出站 fill 上报一条，落 `.ai-runner/logs/send.jsonl`。
//
// [WHY] 「应用往 AI 页面发了多少条提问」是限流/频繁提问类故障的**唯一直接观测量**，
//   而服务端此前只在「脚本已经到达」之后才有日志（reject / runner）—— 出站本身**零留痕**。
//   于是所有判据都是间接的：频控阈值只能拍、同轮双发只能猜、
//   「一条回复含 N 块 ⇒ N 次提问」只能从 run 数推算，修复也无法回归验证。
//
// [CONSTRAINT] **只加日志，不改行为**：本路由不参与任何业务判定，永远返回 200；
//   非 JSON / 缺字段 / 字段类型离谱都只影响这一条的字段质量，绝不产生错误语义给调用方。
// [CONSTRAINT] 入参不可信（唯一由浏览器内容驱动的日志通道）⇒ 落盘行长必须有界：
//   所有字符串字段经 buildSendEntry 单行化 + 限长，故无论请求体多大，**每行体积恒定有界**。
//   请求体本身的体积不做单独限制 —— 与本仓其它写路由（/tasks、/run）保持一致，不在此处制造特例。
import { Hono } from 'hono'
import { writeChannelLog } from '../state/snapshot.js'
import { buildSendEntry } from './control-log.js'

/** send-log 路由的 Hono 实例 */
export const sendLogHono = new Hono()

// 出站 fill 上报（fire-and-forget，调用方不读响应体）
sendLogHono.post('/send-log', async (c) => {
  let body: Record<string, unknown> = {}
  // 空体 / 非 JSON 按空对象处理：留痕通道宁可少字段，也不该给调用方制造错误语义
  try { body = (await c.req.json()) as Record<string, unknown> } catch { /* ignore */ }
  writeChannelLog('send', buildSendEntry(body))
  return c.json({ ok: true })
})
