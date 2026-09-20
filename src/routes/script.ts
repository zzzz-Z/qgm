// [refactor-routes] /script/save
import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { getRoot, SCRIPTS_DIR } from '../config.js'
import { ensureDirs } from '../snapshot.js'
import { parseJSON, readBody, sendJSON } from '../http.js'

/** POST /script/save { script } → 落盘到 .ai-runner/scripts/draft-*.cjs */
export async function handleScriptRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (req.method !== 'POST' || url.pathname !== '/script/save') return false
  const body = parseJSON<{ script?: string }>(await readBody(req))
  const scriptText = String(body?.script || '').trim()
  if (!scriptText) { sendJSON(res, { error: '脚本为空' }, 400); return true }
  ensureDirs()
  const name = `draft-${Date.now()}.cjs`
  const file = path.join(SCRIPTS_DIR, name)
  fs.writeFileSync(file, scriptText)
  sendJSON(res, { ok: true, path: path.relative(getRoot(), file) })
  return true
}
