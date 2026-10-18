// [lesson-route-v1] POST /lessons：接收 DONE 总结正文，提取「踩坑记录」段并追加到 lessons.md。
// [WHY] 前端 SPA 无 fs 权限，且 HCLC 铁律 3 禁止 client import core；采集逻辑唯一一份留在 core，
//       前端经 HTTP 调用。此前唯一接线点在 attach-ws.ts 的 headless 轮询，前端会话绕过。
// [CONSTRAINT] text 为空返回 200 + ok:false（AI 看字段判成败，与 skills/install 同构）；
//              提取为空同样 200 + added:0，不抛错。
// [CHANGE-IMPACT] 与 attach-ws.ts 的 headless 采集共用 extractLessons/appendLessons；
//                 去重按标题，两路并发也只会落一条。
import { Hono } from 'hono'
import { getRoot } from '../config.js'
import { appendLessons, extractLessons } from '../post-run/lesson-extract.js'
import { listLessonDocs, rankLessons } from '../lessons/retriever.js'
import { listDocChunks, rankDocChunks } from '../retrieval/docs-retriever.js'

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

/**
 * POST /lessons/match：按任务文本检索最相关的 lessons 条目。
 * [WHY] 尾截断注入只覆盖 5.3%，95 条 [VERIFIED] 不在场；改为按当前任务检索 top-k。
 * [CONSTRAINT] 查询为空 / 无命中 → 空 matches；任何异常不抛，返回空 matches。
 * [CHANGE-IMPACT] 被客户端 buildLessonsBlock(query) 消费；limit 与注入预算共同决定首问体积。
 */
lessonsHono.post('/lessons/match', async (c) => {
  let query = ''
  let requestedLimit: number | null = null
  let limit = 3
  // [docs-retrieval-v1] scope: 'lessons'（默认，向后兼容）| 'docs'。
  // 无 'all'——lessons+docs 混语料会让 df/DF_RATIO_MAX/avgLen 双向污染，要两边发两次请求。
  let scope = 'lessons'
  try {
    const body = await c.req.json()
    query = String(body && body.query ? body.query : '')
    const n = Number(body && body.limit)
    if (Number.isFinite(n) && n > 0) {
      requestedLimit = Math.floor(n)
      // [limit-visible-v1] 与 /skills/match 同口径：钳到上限而非静默降回默认值。
      limit = Math.min(requestedLimit, 10)
    }
    if (body && body.scope === 'docs') scope = 'docs'
  } catch { /* 请求体非 JSON，按空查询处理 */ }

  try {
    if (scope === 'docs') {
      const chunks = listDocChunks(getRoot())
      const ranked = rankDocChunks(query, chunks, limit)
      const matches = ranked.map(r => ({
        title: r.title,
        body: r.body,
        src: r.src,
        srcKind: r.srcKind,
        hash: r.hash,
        score: Number(r.score.toFixed(3)),
        matched: r.matched,
      }))
      return c.json({ ok: true, query, scope, matches, requestedLimit, appliedLimit: limit })
    }
    const docs = listLessonDocs(getRoot())
    const ranked = rankLessons(query, docs, limit)
    const matches = ranked.map(r => ({
      title: r.title,
      body: r.body,
      state: r.state,
      score: Number(r.score.toFixed(3)),
      matched: r.matched,
    }))
    return c.json({ ok: true, query, scope, matches, requestedLimit, appliedLimit: limit })
  } catch {
    return c.json({ ok: true, query, scope, matches: [], requestedLimit, appliedLimit: limit })
  }
})
