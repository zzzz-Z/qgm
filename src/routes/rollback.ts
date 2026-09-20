// [refactor-routes] /rollback + /rollback-all + /save
import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { getRoot } from '../config.js'
import { readManifest, runDir } from '../snapshot.js'
import { parseJSON, readBody, sendJSON } from '../http.js'

/** 单文件 / 全量回滚 + 确认保存 */
export async function handleRollbackRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (req.method !== 'POST') return false

  if (url.pathname === '/rollback') {
    const body = parseJSON<{ runId?: string, file?: string }>(await readBody(req))
    const { runId, file } = body || {}
    if (!runId || !file) { sendJSON(res, { error: '缺 runId 或 file' }, 400); return true }

    const dir = runDir(String(runId))
    if (!fs.existsSync(dir)) { sendJSON(res, { error: '运行记录不存在' }, 404); return true }

    const manifest = readManifest(String(runId))
    if (!manifest) { sendJSON(res, { error: '快照损坏' }, 500); return true }

    const change = manifest.changes.find(c => c.path === file)
    if (!change) { sendJSON(res, { error: '该文件不在本次改动中' }, 400); return true }

    const target = path.join(getRoot(), change.path)
    if (change.type === 'added') {
      if (fs.existsSync(target)) fs.unlinkSync(target)
    } else {
      const bak = path.join(dir, `${change.path}.before`)
      if (!fs.existsSync(bak)) { sendJSON(res, { error: '快照文件缺失' }, 500); return true }
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(bak, target)
    }
    sendJSON(res, { ok: true, file: change.path, type: change.type })
    return true
  }

  if (url.pathname === '/rollback-all') {
    const body = parseJSON<{ runId?: string }>(await readBody(req))
    const { runId } = body || {}
    if (!runId) { sendJSON(res, { error: '缺 runId' }, 400); return true }

    const dir = runDir(String(runId))
    if (!fs.existsSync(dir)) { sendJSON(res, { error: '运行记录不存在' }, 404); return true }

    const manifest = readManifest(String(runId))
    if (!manifest) { sendJSON(res, { error: '快照损坏' }, 500); return true }

    let n = 0
    for (const c of manifest.changes) {
      const target = path.join(getRoot(), c.path)
      if (c.type === 'added') {
        if (fs.existsSync(target)) { fs.unlinkSync(target); n++ }
      } else {
        const bak = path.join(dir, `${c.path}.before`)
        if (fs.existsSync(bak)) {
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.copyFileSync(bak, target)
          n++
        }
      }
    }
    fs.rmSync(dir, { recursive: true, force: true })
    sendJSON(res, { ok: true, count: n })
    return true
  }

  if (url.pathname === '/save') {
    const body = parseJSON<{ runId?: string }>(await readBody(req))
    const { runId } = body || {}
    if (!runId) { sendJSON(res, { error: '缺 runId' }, 400); return true }

    const dir = runDir(String(runId))
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
    sendJSON(res, { ok: true })
    return true
  }

  return false
}
