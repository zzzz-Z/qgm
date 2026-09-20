// [refactor-routes] /hooks/run + /skills/load
import path from 'node:path'
import { createRequire } from 'node:module'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { getRoot } from '../config.js'
import { runHook } from '../hooks.js'
import type { HookEvent } from '../hooks.js'
import { parseJSON, readBody, sendJSON } from '../http.js'

/** /hooks/run + /skills/load */
export async function handleHooksRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  // 文件树 / 检索 / 快照读取类路由（委派到 files-routes.ts）
  if (req.method === 'POST' && url.pathname === '/hooks/run') {
    const body = parseJSON<{ event?: string, payload?: unknown }>(await readBody(req))
    const event = String(body?.event || '') as HookEvent
    const ALLOWED: HookEvent[] = ['BeforeFill', 'BeforeScript', 'AfterScript', 'AfterResult', 'LoopStop']
    if (!ALLOWED.includes(event)) { sendJSON(res, { error: `未知事件: ${event}` }, 400); return true }
    const r = await runHook(event, body?.payload)
    sendJSON(res, r); return true
  }

  if (req.method === 'POST' && url.pathname === '/skills/load') {
    const body = parseJSON<{ task?: string }>(await readBody(req))
    const task = String(body?.task || '').trim()
    if (!task) { sendJSON(res, { error: 'task 为空' }, 400); return true }
    try {
      const require = createRequire(import.meta.url)
      const loader = require(path.join(getRoot(), 'skills/_loader.cjs'))
      const meta = typeof loader.loadForMeta === 'function'
        ? loader.loadForMeta(task)
        : { content: loader.loadFor(task), keys: [] }
      sendJSON(res, { content: meta.content, keys: meta.keys }); return true
    } catch (e) {
      sendJSON(res, { error: String(e) }, 500); return true
    }
  }
  return false
}
