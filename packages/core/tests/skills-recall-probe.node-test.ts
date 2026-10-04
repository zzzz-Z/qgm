// [agenda-8] P1-2 bigram 错切：matched 应含整词、不含跨词边界碎片
// WHY: 现状对「浏览器」产出 [浏览, 览器]（跨词边界碎片），本测试钉住修法目标。
// CONSTRAINT: 断言打在 ScoredSkill.matched（rankSkills 返回对象数组，不是 token 字符串）。
//   期望值取自 skill-recall-baseline.txt（ROUND 7 真实语料）。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { rankSkills } from '../../../packages/core/src/skills/retriever.js'
import { realSkillDocs } from './fixtures/real-skills.js'

const CASES = [
  { q: '浏览器', mustInclude: '浏览器', mustExclude: '览器' },
  { q: '在 Docker 里跑 headless 浏览器并排查构建慢的问题', mustInclude: '浏览器', mustExclude: '览器' },
  { q: '把这段代码重构一下', mustInclude: '重构', mustExclude: '览器' },
  { q: '页面样式出了问题需要调整', mustInclude: '样式', mustExclude: '览器' },
  { q: '修复登录按钮点击没有反应', mustInclude: '修复', mustExclude: '览器' },
  { q: '今天天气怎么样', mustInclude: '', mustExclude: '', expectEmpty: true },
]

test('AGENDA-8: matched 应含整词、不含跨词边界碎片', () => {
  const docs = realSkillDocs()
  for (const c of CASES) {
    const r = rankSkills(c.q, docs, 3)
    if (c.expectEmpty) {
      assert.equal(r.length, 0, `[${c.q}] 期望 0 条`)
      continue
    }
    assert.ok(r.length > 0, `[${c.q}] 应召回到技能`)
    const anyHas = r.some(x => x.matched.includes(c.mustInclude))
    const dump = r.map(x => `${x.name}:${JSON.stringify(x.matched)}`).join('; ')
    assert.ok(anyHas, `[${c.q}] 至少一个技能 matched 应含「${c.mustInclude}」，实得 [${dump}]`)
    for (const x of r) {
      assert.ok(!x.matched.includes(c.mustExclude), `[${c.q}] ${x.name} matched 不应含「${c.mustExclude}」`)
    }
  }
})

test('AGENDA-8: 零回归 —— baseline 其它 query 召回不退化且不含碎片', () => {
  const docs = realSkillDocs()
  const queries = [
    '用 vitest 写单元测试',
    'write a vue component with defineProps',
    'write a test with vitest',
  ]
  for (const q of queries) {
    const r = rankSkills(q, docs, 3)
    assert.ok(r.length > 0, `[${q}] 应召回到技能`)
    for (const x of r) {
      assert.ok(!x.matched.includes('览器'), `[${q}] ${x.name} 不应含碎片「览器」`)
    }
  }
})

// [A-ADDED@ROUND-2] 复核方补：拉丁侧词边界。
// WHY: pickMatchedSpans 用 q.indexOf(t) 定位且未做词边界校验 → 短词会命中更长单词的内部
//   （token「test」在「vitest」里被 indexOf 再命中一次 → matched 出现重复条目；
//   实测旧实现只产出 1 个，新实现产出 2 个，属本次修法引入的回归）。
// 两个可失败点：① matched 无重复条目；② 每个拉丁片段在 query 里必须落在词边界上。
test('AGENDA-1: 拉丁侧词边界 —— 短词不得命中长词内部（A 补）', () => {
  const docs = realSkillDocs()
  for (const q of ['write a test with vitest', 'vitest 单元测试']) {
    const r = rankSkills(q, docs, 3)
    for (const x of r) {
      const dump = JSON.stringify(x.matched)
      assert.equal(
        new Set(x.matched).size,
        x.matched.length,
        `[${q}] ${x.name} matched 有重复条目 ${dump}（短词命中了更长单词的内部）`,
      )
      for (const m of x.matched) {
        if (!/^[a-z0-9_]+$/.test(m)) continue
        const re = new RegExp(`(?<![a-z0-9_])${m}(?![a-z0-9_])`)
        assert.ok(
          re.test(q.toLowerCase()),
          `[${q}] ${x.name} 的 matched「${m}」未落在词边界（是更长单词的内部片段）`,
        )
      }
    }
  }
})
