// [wiki-proxy-v1] LLM Wiki 知识库代理路由：GET /wiki/health、GET /wiki/search。
// [WHY] token 必须只存在于服务端进程——沙箱子进程 env 为 {...process.env, ...}
//   （post-run/run-script.ts），而 process 在沙箱内可用（仅禁 .exit）⇒ token 一旦进 env，
//   AI 脚本可 console.log(process.env.LLM_WIKI_TOKEN) 把它渲染到页面。代理是唯一合规做法。
// [CONSTRAINT] 转发目标恒为配置的 LLM_WIKI_URL，不接受任何请求侧 host/url 参数（SSRF 收窄）；
//   env 必须请求期读取，不得模块顶层缓存（判据靠 env 注入 stub 端口）。
// [CHANGE-IMPACT] 被工作台「知识库」面板消费；字段名即前端契约；另挂 routes/index.ts barrel 与
//   server/handle.ts 的 WORKSPACE_EXEMPT_PREFIXES、state/snapshot.ts 的 LogChannel。
import { Hono } from 'hono'
import { writeChannelLog } from '../state/snapshot.js'
import { toSingleLine } from './control-log.js'

/** wiki 路由的 Hono 实例 */
export const wikiHono = new Hono()

/** 上游默认地址（LLM Wiki 本机 HTTP API） */
const DEFAULT_BASE = 'http://127.0.0.1:19828'
/** 转发超时毫秒数（上游不可达时快速降级，不拖慢工作台） */
const TIMEOUT_MS = 3000
/** 上游健康端点（plan §1.1 实测路径） */
const UPSTREAM_HEALTH = '/api/v1/health'
/** 上游检索端点（plan §1.1 实测路径） */
const UPSTREAM_SEARCH = '/api/v1/search'

/**
 * 读取配置（**请求期调用，禁止模块顶层缓存**）
 * [WHY] 判据靠 env 注入 stub 端口；顶层缓存会让注入失效 ⇒ 判据恒真（真空）。
 * [CONSTRAINT] token 缺失不算错误——视为「未配置」，调用方转 degraded。
 */
function readConfig(): { base: string, token: string } {
  const base = process.env.LLM_WIKI_URL || DEFAULT_BASE
  const token = process.env.LLM_WIKI_TOKEN || ''
  return { base, token }
}

/**
 * 拼接上游 URL 并断言 origin 未越界（收窄 SSRF 面）
 * [WHY] 转发目标恒为配置 base；一旦将来加了 ?url= 之类透传而忘校验，代理即成跳板。
 * @returns 完整 URL；origin 不匹配返回 null（调用方转 degraded）
 */
function buildUpstreamUrl(base: string, apiPath: string, params: Record<string, string>): string | null {
  try {
    const origin = new URL(base).origin
    const u = new URL(apiPath, base)
    if (u.origin !== origin) return null
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
    return u.toString()
  } catch { return null }
}

/** 上游不可达/超时/非 2xx 的统一降级体（HTTP 200，不得返回 results:[] 混淆「没启动」与「查无结果」） */
function degraded(reason: string): { ok: false, degraded: true, reason: string } {
  return { ok: false, degraded: true, reason }
}

/**
 * 带超时的上游 GET；成功返回解析后的 JSON，失败抛错（由调用方转 degraded）
 * [CONSTRAINT] fetch 必须 try/catch——超时抛 TimeoutError、拒连抛 TypeError，均不得冒泡成 500
 */
async function fetchUpstream(url: string, token: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

wikiHono.get('/wiki/health', async (c) => {
  const { base, token } = readConfig()
  if (!token) return c.json(degraded('LLM_WIKI_TOKEN 未配置'))
  const url = buildUpstreamUrl(base, UPSTREAM_HEALTH, {})
  if (!url) return c.json(degraded('LLM_WIKI_URL 非法'))
  const t0 = Date.now()
  try {
    const data = await fetchUpstream(url, token)
    writeChannelLog('wiki', { path: '/health', degraded: false, ms: Date.now() - t0 })
    return c.json({ ok: true, degraded: false, upstream: data })
  } catch (e) {
    // [token-boundary] reason 只带错误类别，绝不拼接含 token 的原始 URL/headers
    const reason = e instanceof Error ? e.name : 'unknown'
    writeChannelLog('wiki', { path: '/health', degraded: true, reason, ms: Date.now() - t0 })
    return c.json(degraded(reason))
  }
})

wikiHono.get('/wiki/search', async (c) => {
  const { base, token } = readConfig()
  const q = c.req.query('q') || ''
  const limit = c.req.query('limit') || '10'
  if (!token) return c.json(degraded('LLM_WIKI_TOKEN 未配置'))
  const url = buildUpstreamUrl(base, UPSTREAM_SEARCH, { q, limit })
  if (!url) return c.json(degraded('LLM_WIKI_URL 非法'))
  const t0 = Date.now()
  try {
    const data = await fetchUpstream(url, token) as { results?: unknown }
    const results = Array.isArray(data?.results) ? data.results : []
    writeChannelLog('wiki', { path: '/search', q: toSingleLine(q, 200), hits: results.length, degraded: false, ms: Date.now() - t0 })
    return c.json({ ok: true, degraded: false, results })
  } catch (e) {
    const reason = e instanceof Error ? e.name : 'unknown'
    writeChannelLog('wiki', { path: '/search', q: toSingleLine(q, 200), degraded: true, reason, ms: Date.now() - t0 })
    return c.json(degraded(reason))
  }
})
