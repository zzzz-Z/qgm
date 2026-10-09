'use strict'

/** [api-ssot-v1] 本文件是本族 API 签名的唯一 SSOT；SYSTEM.md §3.2 与 ai-guard 注入只列「名字 + 常用项」，完整签名/返回/异常以本文件 JSDoc 为准。 */

/**
 * [helpers-lessons-v1] 沙箱侧 lessons 检索：任务中途遇非显而易见报错时可主动查知识库。
 *
 * [WHY] 此前检索只在「会话首问 / 循环首轮」按 goal 预加载一次；中途换新错误类型不会重检索，
 * AI 只能靠首轮注入的几条，或手动读全文（受 §10 预算）。本方法补上按需检索通道。
 *
 * [CONSTRAINT] 走 HTTP 端口机制（AIR_SERVER_PORT / AIR_RUNNER_SERVER_PORT）；
 * 失败返回 {ok:false,error} 不抛。
 *
 * [CHANGE-IMPACT] 被 AI 脚本 `await __AI__.lessons.match('<错误文本>')` 消费；
 * 端点 POST /__ai/lessons/match。
 */

/**
 * 按 query 检索 lessons 知识库。
 * @param {string} query 错误关键词或任务描述（截断到 2000 字符）
 * @param {number} [limit] 返回条数，默认 3，上限 10
 * @returns {Promise<{ok: boolean, query: string, matches: unknown[]}>}
 */
async function match(query, limit) {
  const port = Number(process.env.AIR_SERVER_PORT || process.env.AIR_RUNNER_SERVER_PORT) || 5175
  const q = String(query || '').slice(0, 2000)
  if (!q) return { ok: false, error: 'empty-query', matches: [] }
  const n = Number(limit)
  const body = { query: q, limit: Number.isFinite(n) && n > 0 && n <= 10 ? Math.floor(n) : 3 }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/__ai/lessons/match`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, matches: [] }
    const j = await res.json()
    return {
      ok: Boolean(j && j.ok),
      query: q,
      matches: Array.isArray(j && j.matches) ? j.matches : [],
    }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), matches: [] }
  }
}

module.exports = { match }
