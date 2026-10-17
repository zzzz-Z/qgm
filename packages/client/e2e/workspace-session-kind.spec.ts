// [workspace-session-kind-v1] `/__ai/workspace/session` 的 kind 三形态契约。
// [WHY] workspace-schema-v2 起 homeUrl 与 sessionUrl 分离，写入必须能区分「绑站点」与「绑会话」；
//   缺省推断规则是兼容旧两参调用的唯一保证，必须由契约测试锁住。
// [CONSTRAINT] 加性契约变更按 AGENTS.md「改请求体契约补 e2e」执行；spec 自行拉起后端。
import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BASE = process.env.AI_E2E_BASE_URL || 'http://127.0.0.1:5175'

test('[workspace-session-kind-v1] site / session / 缺省推断三形态与 GET 派生形状', async ({ request }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-runner-e2e-ws-'))
  const reg = await request.post(`${BASE}/__ai/workspace/register`, { data: { path: dir } })
  const regJson = await reg.json()
  expect(regJson.ok).toBe(true)
  const id = regJson.workspace.id as string

  // ① 显式 site：写 homeUrl 并清 sessionUrl/sessionId
  const r1 = await request.post(`${BASE}/__ai/workspace/session`, {
    data: { id, kind: 'site', homeUrl: 'https://chat.deepseek.com/' },
  })
  expect(r1.ok()).toBe(true)
  const s1 = (await r1.json()).session
  expect(s1.url).toBe('https://chat.deepseek.com/')
  expect(s1.sessionId).toBe('')

  // ② 显式 session：写 sessionUrl/sessionId，homeUrl 保留
  const r2 = await request.post(`${BASE}/__ai/workspace/session`, {
    data: { id, kind: 'session', sessionUrl: 'https://chat.deepseek.com/a/chat/s/abc', sessionId: 'abc' },
  })
  expect(r2.ok()).toBe(true)
  const s2 = (await r2.json()).session
  expect(s2.url).toBe('https://chat.deepseek.com/a/chat/s/abc')
  expect(s2.sessionId).toBe('abc')

  // ③ 缺省推断：sessionId 非空 → session
  const r3 = await request.post(`${BASE}/__ai/workspace/session`, {
    data: { id, url: 'https://chat.deepseek.com/a/chat/s/def', sessionId: 'def' },
  })
  const s3 = (await r3.json()).session
  expect(s3.sessionId).toBe('def')

  // ④ 缺省推断：sessionId 空 → site（url 当 homeUrl）
  const r4 = await request.post(`${BASE}/__ai/workspace/session`, {
    data: { id, url: 'https://chat.deepseek.com/', sessionId: '' },
  })
  const s4 = (await r4.json()).session
  expect(s4.url).toBe('https://chat.deepseek.com/')
  expect(s4.sessionId).toBe('')

  // ⑤ GET 派生形状不变：url = sessionUrl || homeUrl
  await request.post(`${BASE}/__ai/workspace/session`, {
    data: { id, kind: 'session', sessionUrl: 'https://chat.deepseek.com/a/chat/s/ghi', sessionId: 'ghi' },
  })
  const g = await request.get(`${BASE}/__ai/workspace/session`)
  const gj = await g.json()
  expect(gj.sessions[id].url).toBe('https://chat.deepseek.com/a/chat/s/ghi')
  expect(gj.sessions[id].sessionId).toBe('ghi')

  // ⑥ registry 条目内联新字段
  const rg = await request.get(`${BASE}/__ai/workspace/registry`)
  const rgj = await rg.json()
  const item = (rgj.workspaces as { id: string, session?: { homeUrl: string, sessionUrl: string } }[]).find(w => w.id === id)
  expect(item?.session?.sessionUrl).toBe('https://chat.deepseek.com/a/chat/s/ghi')
  expect(item?.session?.homeUrl).toBe('https://chat.deepseek.com/')

  // ⑦ 清理：出册
  await request.post(`${BASE}/__ai/workspace/remove`, { data: { id } })
  fs.rmSync(dir, { recursive: true, force: true })
})
