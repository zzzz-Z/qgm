// [workspace-nav-confirm-v1] 导航确认：切工作区导航到 sessionUrl 后，8s 内没收到该站点的
//   url-updated 就 warn——绑定的会话 URL 可能已失效（站点静默重定向回首页）。
// [WHY] D2 选择「被动纠正 + 本地超时兜底」：url-updated 负责纠正落点，超时负责让失败可见。
// [承重] 删掉定时器设置 → 第一例红；删掉 confirmNav 调用 → 第二例红；
//   把 confirmNav 挪到 parseSessionUrl 之后 → 第三例红。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { describe, it } from 'vitest'
import { confirmNav, NAV_CONFIRM_TIMEOUT_MS } from '../composables/data/useWorkspaces.js'

const WS = () => fs.readFileSync(new URL('../composables/data/useWorkspaces.ts', import.meta.url), 'utf8')
const H = () => fs.readFileSync(new URL('../composables/ai/useAiReplyHandlers.ts', import.meta.url), 'utf8')

describe('confirmNav（行为）', () => {
  it('无定时器时调用是幂等的（不抛错）', () => {
    assert.doesNotThrow(() => confirmNav('sid-not-pending'))
    assert.doesNotThrow(() => confirmNav(''))
  })

  it('超时常量为 8s', () => {
    assert.equal(NAV_CONFIRM_TIMEOUT_MS, 8_000)
  })
})

describe('导航后挂确认定时器（源码断言）', () => {
  function switchBody(): string {
    const s = WS()
    const i = s.indexOf('async function switchDeepSeekSession')
    assert.ok(i > 0, '未找到 switchDeepSeekSession：结构已变，守卫需同步')
    const end = s.indexOf('async function backfillSessionId', i)
    return s.slice(i, end > 0 ? end : i + 3000)
  }

  it('openAiSession 之后必须设置 pendingNavBySid 定时器', () => {
    const b = switchBody()
    const openIdx = b.indexOf('await openAiSession(')
    const setIdx = b.indexOf('pendingNavBySid.set(')
    assert.ok(openIdx > 0, '未找到 openAiSession 调用')
    assert.ok(setIdx > openIdx, '定时器必须在导航之后设置')
    // [承重] 必须是行首独立语句：`void 0 && pendingNavBySid.set(...)` 这类短路写法虽然含子串，
    //   但定时器永不执行——只查子串会让这种「语法上存在、逻辑上失效」的改写蒙混过关。
    assert.ok(/^\s*pendingNavBySid\.set\(/m.test(b), '定时器必须是独立语句，不能被短路前缀包住')
    assert.ok(/NAV_CONFIRM_TIMEOUT_MS/.test(b), '未使用超时常量')
    assert.ok(/console\.warn/.test(b), '超时后必须 warn：失败要可见')
  })

  it('设置新定时器前必须先 confirmNav 清旧的', () => {
    const b = switchBody()
    const clearIdx = b.indexOf('confirmNav(targetSid)')
    const setIdx = b.indexOf('pendingNavBySid.set(')
    assert.ok(clearIdx > 0, '未先清旧定时器')
    assert.ok(clearIdx < setIdx, '清旧必须在设新之前')
  })
})

describe('handleUrlUpdated 确认导航（源码断言）', () => {
  function body(): string {
    const s = H()
    const i = s.indexOf('function handleUrlUpdated')
    assert.ok(i > 0, '未找到 handleUrlUpdated')
    const end = s.indexOf('function handleSessionIdUpdate', i)
    return s.slice(i, end > 0 ? end : i + 1200)
  }

  it('必须调用 confirmNav', () => {
    assert.ok(/confirmNav\(sidForUrl\(u\)\)/.test(body()), '收到 url-updated 未确认导航')
  })

  it('确认必须在反解 return 之前（重定向回首页也算导航完成）', () => {
    const b = body()
    const confirmIdx = b.indexOf('confirmNav(')
    const parseIdx = b.indexOf('parseSessionUrl(')
    const returnIdx = b.indexOf('if (!parsed) return')
    assert.ok(confirmIdx > 0 && parseIdx > 0 && returnIdx > 0, '结构已变，守卫需同步')
    assert.ok(confirmIdx < returnIdx, '确认若在反解 return 之后，重定向回首页的情形会误报超时')
  })
})
