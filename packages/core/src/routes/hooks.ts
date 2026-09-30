// [arch-hono/hooks-v1] /hooks/*
import { Hono } from 'hono'
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
