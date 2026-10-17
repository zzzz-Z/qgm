// [workspace-schema-v2] handleUrlUpdated 两条硬约束的承重判据：
//   ① 反解失败（首页 / 陌生 URL）必须跳过持久化 —— 否则用户仅浏览首页就会用首页覆盖好绑定（Q2）；
//   ② 反解成功才落盘，且 sessionId 从 URL 反解，不得回退 activeSessionId（P4：多站点并行会写错工作区）。
// [承重] 去掉「反解失败 return」→ 第一例必红；把 sessionId 改回 activeSessionId → 第二例必红。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { describe, it } from 'vitest'
import { parseSessionUrl } from '../composables/ai/useAiReplyHandlers.js'
import { MODELS } from '../composables/ai/useAiSite.js'

const SRC = () => fs.readFileSync(new URL('../composables/ai/useAiReplyHandlers.ts', import.meta.url), 'utf8')

describe('parseSessionUrl（反解）', () => {
  it('会话 URL → 解出 modelId + sessionId', () => {
    const r = parseSessionUrl('https://chat.deepseek.com/a/chat/s/abc-123', MODELS)
    assert.deepEqual(r, { modelId: 'deepseek', sessionId: 'abc-123' })
  })

  it('站点首页 → null（不得被当成会话）', () => {
    assert.equal(parseSessionUrl('https://chat.deepseek.com/', MODELS), null)
  })

  it('陌生 URL → null', () => {
    assert.equal(parseSessionUrl('https://example.com/x', MODELS), null)
  })

  it('空串 → null', () => {
    assert.equal(parseSessionUrl('', MODELS), null)
  })

  it('跨站点：千问模板同样可解', () => {
    const r = parseSessionUrl('https://www.qianwen.com/chat/qw-9', MODELS)
    assert.deepEqual(r, { modelId: 'qianwen', sessionId: 'qw-9' })
  })
})

describe('handleUrlUpdated 接线（源码断言）', () => {
  function body(): string {
    const s = SRC()
    const i = s.indexOf('function handleUrlUpdated')
    assert.ok(i > 0, '未找到 handleUrlUpdated：结构已变，守卫需同步')
    const end = s.indexOf('function handleSessionIdUpdate', i)
    return s.slice(i, end > 0 ? end : i + 1200)
  }

  it('反解失败必须跳过持久化（Q2）', () => {
    const b = body()
    assert.ok(/parseSessionUrl\(/.test(b), '未走反解：无法区分首页与会话')
    assert.ok(/if \(!parsed\) return/.test(b), '反解失败未 return：首页会覆盖既有绑定')
  })

  it('不得回退 activeSessionId（P4）', () => {
    assert.ok(!/activeSessionId\.value/.test(body()), '回退 activeSessionId 会把别的窗口的会话 id 写到本工作区')
  })

  it('persistSessionBinding 显式 kind:session 且失败可见', () => {
    const s = SRC()
    const i = s.indexOf('async function persistSessionBinding')
    const b = s.slice(i, s.indexOf('function handleUrlUpdated', i))
    assert.ok(/kind: 'session'/.test(b), '未显式 kind：服务端推断可能与意图不符')
    assert.ok(/log\.warn/.test(b), '回写失败仍静默：绑定不生效无从定位')
  })
})
