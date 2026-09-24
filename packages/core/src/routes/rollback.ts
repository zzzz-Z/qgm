// [arch-hono/rollback-v1] /rollback + /rollback-all + /save 路由 Hono 版（fetch handler）
import { Hono } from 'hono'
import fs from 'node:fs'
import path from 'node:path'
import { getRoot } from '../config.js'
import { readManifest, runDir } from '../state/snapshot.js'

/** rollback 路由的 Hono 实例 */
export const rollbackHono = new Hono()

rollbackHono.post('/rollback', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { runId?: string, file?: string } | null
  const { runId, file } = body || {}
  if (!runId || !file) return c.json({ error: '缺 runId 或 file' }, 400)
  const dir = runDir(String(runId))
  if (!fs.existsSync(dir)) return c.json({ error: '运行记录不存在' }, 404)
  const manifest = readManifest(String(runId))
  if (!manifest) return c.json({ error: '快照损坏' }, 500)
  const change = manifest.changes.find(x => x.path === file)
  if (!change) return c.json({ error: '该文件不在本次改动中' }, 400)
  const target = path.join(getRoot(), change.path)
  if (change.type === 'added') {
    if (fs.existsSync(target)) fs.unlinkSync(target)
  } else {
    const bak = path.join(dir, `${change.path}.before`)
    if (!fs.existsSync(bak)) return c.json({ error: '快照文件缺失' }, 500)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(bak, target)
  }
  return c.json({ ok: true, file: change.path, type: change.type })
})

rollbackHono.post('/rollback-all', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { runId?: string } | null
  const runId = body?.runId
  if (!runId) return c.json({ error: '缺 runId' }, 400)
  const dir = runDir(String(runId))
  if (!fs.existsSync(dir)) return c.json({ error: '运行记录不存在' }, 404)
  const manifest = readManifest(String(runId))
  if (!manifest) return c.json({ error: '快照损坏' }, 500)
  let n = 0
  for (const ch of manifest.changes) {
    const target = path.join(getRoot(), ch.path)
    if (ch.type === 'added') {
      if (fs.existsSync(target)) { fs.unlinkSync(target); n++ }
    } else {
      const bak = path.join(dir, `${ch.path}.before`)
      if (fs.existsSync(bak)) {
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.copyFileSync(bak, target)
        n++
      }
    }
  }
  fs.rmSync(dir, { recursive: true, force: true })
  return c.json({ ok: true, count: n })
})

rollbackHono.post('/save', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { runId?: string } | null
  const runId = body?.runId
  if (!runId) return c.json({ error: '缺 runId' }, 400)
  const dir = runDir(String(runId))
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  return c.json({ ok: true })
})
