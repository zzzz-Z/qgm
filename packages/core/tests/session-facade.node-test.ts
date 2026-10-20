// [helpers-session-v1] 隔离会话门面承重守卫。
// @why 判据承重：每条在门面方法被删、参数校验被移除、端点被摘除时都会变红。
import { expect, test } from 'vitest'
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const require = createRequire(import.meta.url)
require(path.join(ROOT, 'packages/core/src/helpers.cjs'))
const AI = (globalThis as unknown as { __AI__: Record<string, unknown> }).__AI__
interface S { create: (o?: object) => Promise<unknown>, frame: (s: string, c: string, o?: object) => Promise<{ ok: boolean, error?: string }>, close: (s: string) => Promise<unknown> }
const SESSION = AI.session as unknown as S

test('E1 门面暴露 session 族三个方法', () => {
  expect(typeof AI.session).toBe('object')
  expect(typeof SESSION.create).toBe('function')
  expect(typeof SESSION.frame).toBe('function')
  expect(typeof SESSION.close).toBe('function')
})

test('E2 frame 缺 sid 或 code 时直接拒绝（不得发起请求）', async () => {
  const a = await SESSION.frame('', 'return 1')
  expect(a.ok).toBe(false)
  expect(a.error).toContain('sid')
  const b = await SESSION.frame('sid-x', '')
  expect(b.ok).toBe(false)
  expect(b.error).toContain('code')
})

test('E3 close 缺 sid 时直接拒绝', async () => {
  const r = await SESSION.close('') as { ok: boolean, error?: string }
  expect(r.ok).toBe(false)
  expect(r.error).toContain('sid')
})

test('E4 服务端三个端点均已注册且已挂载（防端点被摘除）', () => {
  const route = fs.readFileSync(path.join(ROOT, 'packages/core/src/routes/session.ts'), 'utf8')
  expect(route).toContain('sessionHono.post(\'/session\'')
  expect(route).toContain('sessionHono.post(\'/session/:sid/frame\'')
  expect(route).toContain('sessionHono.delete(\'/session/:sid\'')
  const idx = fs.readFileSync(path.join(ROOT, 'packages/core/src/routes/index.ts'), 'utf8')
  expect(idx).toContain('sessionHono')
})

test('E5 门面只做 HTTP 转发，不持有会话状态（防本地缓存与服务端漂移）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'packages/core/src/helpers/session.cjs'), 'utf8')
  expect(src).not.toMatch(/new Map|new Set|\bvar\b/)
  expect(src).toContain('fetch(')
})
