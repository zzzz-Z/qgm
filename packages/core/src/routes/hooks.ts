// [arch-hono/hooks-v1] /hooks/* + /skills/load
import { Hono } from 'hono'
import { createRequire } from 'node:module'
import path from 'node:path'
import { getRoot } from '../config.js'
import { runHook } from '../utils/hooks.js'

type HookEvent = 'BeforeFill' | 'BeforeScript' | 'AfterScript' | 'AfterResult' | 'LoopStop'

/** 允许的钩子事件白名单 */
const ALLOWED: HookEvent[] = ['BeforeFill', 'BeforeScript', 'AfterScript', 'AfterResult', 'LoopStop']

/** hooks 路由的 Hono 实例 */
export const hooksHono = new Hono()

hooksHono.post('/hooks/run', async (c) => {
  let body: { event?: string, payload?: unknown } | null = null
  try { body = await c.req.json() } catch { body = null }
  const event = String(body?.event || '') as HookEvent
  if (!ALLOWED.includes(event)) return c.json({ error: `未知事件: ${event}` }, 400)
  const r = await runHook(event, body?.payload)
  return c.json(r)
})

hooksHono.post('/skills/load', async (c) => {
  let body: { task?: string } | null = null
  try { body = await c.req.json() } catch { body = null }
  const task = String(body?.task || '').trim()
  if (!task) return c.json({ error: 'task 为空' }, 400)
  try {
    const require = createRequire(import.meta.url)
    const loader = require(path.join(getRoot(), 'skills/_loader.cjs'))
    const meta = typeof loader.loadForMeta === 'function'
      ? loader.loadForMeta(task)
      : { content: loader.loadFor(task), keys: [] }
    return c.json({ content: meta.content, keys: meta.keys })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})
