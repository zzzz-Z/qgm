// [lesson-route-v1] POST /lessons：接收 DONE 总结正文，提取「踩坑记录」段并追加到 lessons.md。
// [WHY] 前端 SPA 无 fs 权限，且 HCLC 铁律 3 禁止 client import core；采集逻辑唯一一份留在 core，
//       前端经 HTTP 调用。此前唯一接线点在 attach-ws.ts 的 headless 轮询，前端会话绕过。
// [CONSTRAINT] text 为空返回 200 + ok:false（AI 看字段判成败，与 skills/install 同构）；
//              提取为空同样 200 + added:0，不抛错。
// [CHANGE-IMPACT] 与 attach-ws.ts 的 headless 采集共用 extractLessons/appendLessons；
//                 去重按标题，两路并发也只会落一条。
import { Hono } from 'hono'
import { appendLessons, extractLessons } from '../post-run/lesson-extract.js'

/** lessons 路由 Hono 实例 */
export const lessonsHono = new Hono()

/** POST /lessons：body { text: string }，返回 { ok, added } */
lessonsHono.post('/lessons', async (c) => {
  const body = await c.req.json().catch(() => null)
  const text = body && typeof body.text === 'string' ? body.text : ''
  if (!text) return c.json({ ok: false, error: 'empty-text', added: 0 })
  let added = 0
  try {
    added = appendLessons(extractLessons(text))
  } catch { /* 提取/落盘异常不阻断主链路，与 attach-ws 一致 */ }
  return c.json({ ok: true, added })
})
