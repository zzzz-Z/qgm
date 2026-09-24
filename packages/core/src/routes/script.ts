// [arch-hono/script-v1] /script/save 路由 Hono 版（fetch handler）
import { Hono } from 'hono'
import fs from 'node:fs'
import path from 'node:path'
import { getRoot, SCRIPTS_DIR } from '../config.js'
import { ensureDirs } from '../state/snapshot.js'

/** script 路由的 Hono 实例 */
export const scriptHono = new Hono()

// POST /script/save { script } → 落盘到 .ai-runner/scripts/draft-*.cjs
scriptHono.post('/script/save', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { script?: string } | null
  const scriptText = String(body?.script || '').trim()
  if (!scriptText) return c.json({ error: '脚本为空' }, 400)
  ensureDirs()
  const name = `draft-${Date.now()}.cjs`
  const file = path.join(SCRIPTS_DIR, name)
  fs.writeFileSync(file, scriptText)
  return c.json({ ok: true, path: path.relative(getRoot(), file) })
})
