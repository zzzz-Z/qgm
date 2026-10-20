// [probe-family-guard-v1] 新原语必须在门面接线、在注入层可见、行为可用。
// [WHY] 全量日志分析（16,286 脚本）：端口探活 990 次、vitest 10 种写法。
//   新原语若只写进 helpers 而不接进 index.cjs 或注入块，AI 根本看不到 = 白做。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'vitest'

const indexSrc = readFileSync(new URL('../src/helpers/index.cjs', import.meta.url), 'utf8')
const guardSrc = readFileSync(new URL('../src/post-run/ai-guard.ts', import.meta.url), 'utf8')

const APIS = ['probe', 'shellWait', 'testRun']

describe('probe 族三原语', () => {
  for (const name of APIS) {
    it(`${name} 已在 index.cjs 接线`, () => {
      // [WHY] 用字符串包含而非正则：模板字面量里 '\\b'/'\\s' 会失真（初版即栽在这）。
      assert.ok(indexSrc.includes(`${name}(`), `${name} 未接线（AI 看不到）`)
    })

    it(`${name} 已进入每轮注入教学层`, () => {
      assert.ok(guardSrc.includes(name), `${name} 未出现在 AI_JSDOC 注入块（AI 不会知道）`)
    })
  }

  it('注入块不得提及不存在的方法（防幻觉教学）', () => {
    const injected = guardSrc.slice(guardSrc.indexOf('const AI_JSDOC'), guardSrc.indexOf('].join'))
    const mentioned = [...injected.matchAll(/[a-z_$][\w$]*\(/gi)].map(m => m[0].slice(0, -1))
    const skip = new Set(['code', 'filename', 'opts', 's', 'p', 'file', 'a', 'b', 'from', 'to', 'dir', 'pattern', 'cmd', 'msg', 'port', 'files', 'id'])
    for (const m of mentioned) {
      if (skip.has(m)) continue
      assert.ok(indexSrc.includes(m), `注入块提到 ${m} 但门面没有`)
    }
  })
})

describe('testRun 输出解析', () => {
  it('剥 ANSI 后能读到 passed（vitest 输出带颜色码）', async () => {
    const { testRun } = await import('../src/helpers/probe.cjs')
    const fake = '\u001B[2m Tests \u001B[22m \u001B[1m\u001B[32m7 passed\u001B[39m'
    const r = await testRun(['x'], {}, async () => ({ ok: true, stdout: fake, stderr: '' }))
    assert.equal(r.passed, 7)
    assert.equal(r.failed, 0)
  })

  it('失败数与被通过数都能解析', async () => {
    const { testRun } = await import('../src/helpers/probe.cjs')
    const fake = 'Tests 2 failed | 5 passed'
    const r = await testRun(['x'], {}, async () => ({ ok: false, stdout: fake, stderr: '' }))
    assert.equal(r.failed, 2)
    assert.equal(r.passed, 5)
  })

  it('失败文件路径被提取', async () => {
    const { testRun } = await import('../src/helpers/probe.cjs')
    const fake = 'FAIL packages/a.test.ts\nFAIL packages/b.test.ts\nTests 2 failed | 0 passed'
    const r = await testRun(['x'], {}, async () => ({ ok: false, stdout: fake, stderr: '' }))
    assert.deepEqual(r.failedFiles, ['packages/a.test.ts', 'packages/b.test.ts'])
  })
})
