// [skill-match-meta-v1] matchSkills 返回结构与 buildSkillsBlock 的截断可见性守卫。
// [WHY] 服务端早已下发 truncatedByBudget / appliedLimit，但客户端此前只取 matches ——
//   用户无从知道「技能因体积预算被砍」，会误以为「只匹配到这几个」。
// [判据承重] 把 matchSkills 改回只返回 matches 数组 ⇒ T1 必红；
//   删掉 buildSkillsBlock 里的 truncatedByBudget 分支 ⇒ T3 必红。
import assert from 'node:assert/strict'

import { afterEach, it } from 'vitest'

import { buildSkillsBlock, matchSkills } from '../composables/ai/skill-registry.js'

const origFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = origFetch })

/** 把 fetch 换成返回固定 JSON 的桩 */
function stubFetch(json: unknown): void {
  globalThis.fetch = (async () => ({ json: async () => json })) as unknown as typeof fetch
}

it('matchSkills：返回 { matches, truncatedByBudget, appliedLimit } 而非裸数组', async () => {
  stubFetch({
    ok: true,
    matches: [{ name: 'a', path: 'p', score: 1, matched: [], body: 'b' }],
    truncatedByBudget: true,
    appliedLimit: 10,
  })
  const r = await matchSkills('测试查询')
  assert.ok(Array.isArray(r.matches), 'matches 必须是数组')
  assert.equal(r.matches.length, 1)
  assert.equal(r.truncatedByBudget, true, '服务端下发的 truncatedByBudget 必须透传')
  assert.equal(r.appliedLimit, 10, '服务端下发的 appliedLimit 必须透传')
})

it('matchSkills：服务端未下发新字段时回落默认值（向后兼容）', async () => {
  stubFetch({ ok: true, matches: [{ name: 'a', path: 'p', score: 1, matched: [], body: 'b' }] })
  const r = await matchSkills('测试查询', 5)
  assert.equal(r.truncatedByBudget, false, '缺字段时按未截断处理')
  assert.equal(r.appliedLimit, 5, '缺字段时回落到调用方传入的 limit')
})

it('matchSkills：空查询不打网络，返回空 matches + 默认值', async () => {
  let called = false
  globalThis.fetch = (async () => { called = true; return { json: async () => ({}) } }) as unknown as typeof fetch
  const r = await matchSkills('   ')
  assert.equal(called, false, '空 query 必须短路，不得发请求')
  assert.deepEqual(r.matches, [])
  assert.equal(r.truncatedByBudget, false)
})

it('matchSkills：请求失败返回空 matches（不抛错）', async () => {
  globalThis.fetch = (async () => { throw new Error('network down') }) as unknown as typeof fetch
  const r = await matchSkills('测试查询')
  assert.deepEqual(r.matches, [], '失败时必须返回空 matches，不得抛错阻断首问')
  assert.equal(r.truncatedByBudget, false)
})

// [skill-match-meta-v1] 截断可见性：命中被体积预算砍掉时，注入块必须显式告知。
// [判据承重] 删掉 buildSkillsBlock 里的 truncatedByBudget 分支 ⇒ 本用例必红。
it('buildSkillsBlock：truncatedByBudget=true 时注入块含预算说明', async () => {
  stubFetch({
    ok: true,
    matches: [{ name: 'alpha', path: 'p/alpha/SKILL.md', score: 2, matched: [], body: '正文 A' }],
    truncatedByBudget: true,
    appliedLimit: 10,
  })
  const block = await buildSkillsBlock('测试查询')
  assert.ok(block.includes('超过体积预算'), '被体积预算截断时必须显式说明')
  assert.ok(block.includes('10'), '说明里必须带出服务端生效的 limit')
  assert.ok(block.includes('alpha'), '技能正文仍须正常注入')
})

it('buildSkillsBlock：truncatedByBudget=false 时不得出现预算说明（避免噪音）', async () => {
  stubFetch({
    ok: true,
    matches: [{ name: 'beta', path: 'p/beta/SKILL.md', score: 1, matched: [], body: '正文 B' }],
    truncatedByBudget: false,
    appliedLimit: 3,
  })
  const block = await buildSkillsBlock('测试查询')
  assert.ok(!block.includes('超过体积预算'), '未截断时不得出现预算说明')
  assert.ok(block.includes('beta'))
})

it('buildSkillsBlock：零命中返回空串（不注入空标题）', async () => {
  stubFetch({ ok: true, matches: [], truncatedByBudget: false, appliedLimit: 3 })
  assert.equal(await buildSkillsBlock('测试查询'), '')
})
