// /git/* —— HEAD / commit-loop / reset
import type { IncomingMessage, ServerResponse } from 'node:http'
import { gitCommitAll, gitHead, gitResetHard } from '../git.js'
import { parseJSON, readBody, sendJSON } from '../server/http.js'

/** GET /git/head；POST /git/commit-loop；POST /git/reset */
export async function handleGitRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/git/head') {
    const head = await gitHead()
    sendJSON(res, { ok: Boolean(head), head: head || '' })
    return true
  }
  if (req.method === 'POST' && url.pathname === '/git/commit-loop') {
    const body = parseJSON<{ message?: string }>(await readBody(req))
    const message = String(body?.message || 'ai-runner: loop commit').slice(0, 200)
    const r = await gitCommitAll(message)
    sendJSON(res, r, r.ok ? 200 : 400)
    return true
  }
  if (req.method === 'POST' && url.pathname === '/git/reset') {
    const body = parseJSON<{ ref?: string }>(await readBody(req))
    const ref = String(body?.ref || 'HEAD').slice(0, 64)
    const r = await gitResetHard(ref)
    sendJSON(res, r, r.ok ? 200 : 400)
    return true
  }
  return false
}
