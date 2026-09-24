// [arch-hono/search-v1] POST /search 路由 Hono 版（复用 search.ts 纯函数）
import { Hono } from 'hono'
import { getSearchFiles, globToRe, readSearchContentCached, runAstGrep } from '../utils/search.js'

interface SearchBody {
  pattern?: string
  glob?: string
  mode?: string
  max?: number
  lang?: string
}

/** search 路由的 Hono 实例 */
export const searchHono = new Hono()

searchHono.post('/search', async (c) => {
  const body = (await c.req.json().catch(() => null)) as SearchBody | null
  const pattern = String(body?.pattern || '').trim()
  if (!pattern) return c.json({ error: 'pattern 为空' }, 400)
  const modeRaw = String(body?.mode || 'content')
  const mode = modeRaw === 'file' || modeRaw === 'ast' ? modeRaw : 'content'
  const lang = String(body?.lang || 'typescript')
  const globRe = body?.glob ? globToRe(body.glob) : null
  const max = Math.min(Number(body?.max) || 100, 500)

  if (mode === 'ast') {
    const astMax = Math.min(Number(body?.max) || 100, 500)
    const ar = await runAstGrep(pattern, lang, body?.glob || null, astMax)
    if (ar.error) return c.json({ error: ar.error }, 400)
    return c.json({ results: ar.results, truncated: ar.results.length >= astMax })
  }

  let re: RegExp
  try { re = new RegExp(pattern) } catch (e) { return c.json({ error: String(e) }, 400) }

  const hits: Array<{ path: string, line?: number, text?: string }> = []
  for (const f of getSearchFiles()) {
    if (hits.length >= max) break
    if (globRe && !globRe.test(f.rel)) continue

    if (mode === 'file') {
      if (re.test(f.rel)) hits.push({ path: f.rel })
      continue
    }

    const content = readSearchContentCached(f)
    if (content === null || content.length > 400000) continue
    const lines = content.split('\n')
    for (let i = 0; i < lines.length && hits.length < max; i++) {
      if (re.test(lines[i])) {
        hits.push({ path: f.rel, line: i + 1, text: lines[i].trim().slice(0, 200) })
      }
    }
  }
  return c.json({ results: hits, truncated: hits.length >= max })
})
