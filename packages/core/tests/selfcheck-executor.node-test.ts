// [selfcheck-executor-test-v1] 期一自检执行器单元测试
// 覆盖工单 G4（命令对账命中造假）G5（变更集对账）+ 解析函数
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { parseDeclaredChanges, parseDeclaredCommands, reconcileChanges, reconcileCommands, runSelfcheck } from '../src/selfcheck/executor.js'

test('G5: 变更集一致 → pass', () => {
  const d = [{ path: 'a.ts', kind: '修改' }, { path: 'b.ts', kind: '新增' }]
  const r = reconcileChanges(d, ['a.ts', 'b.ts'])
  assert.equal(r.ok, true)
})

test('G5: 多报一个不存在文件 → fail', () => {
  const d = [{ path: 'a.ts', kind: '修改' }, { path: 'nope.ts', kind: '新增' }]
  const r = reconcileChanges(d, ['a.ts'])
  assert.equal(r.ok, false)
  assert.ok(r.details?.some(x => x.includes('nope.ts')))
})

test('G5: 少报实测文件 → 不拦（claimed ⊆ actual，[selfcheck-subset-v1]）', () => {
  const r = reconcileChanges([{ path: 'a.ts', kind: '修改' }], ['a.ts', 'c.ts'])
  assert.equal(r.ok, true)
  assert.ok(r.details?.some(x => x.includes('未声称')))
})

test('G4: 命令对账命中造假（声称 vitest 但未观察到） → fail', () => {
  const r = reconcileCommands(['pnpm test:unit'], ['tsc', 'eslint'])
  assert.equal(r.ok, false)
  assert.ok(r.details?.some(x => x.includes('pnpm')))
})

test('G4: 命令对账全命中 → pass', () => {
  const r = reconcileCommands(['pnpm test:unit', 'pnpm tsc'], ['pnpm', 'tsc'])
  assert.equal(r.ok, true)
})

test('parseDeclaredChanges: 解析 markdown 表', () => {
  const text = [
    '### 变更文件',
    '',
    '| 文件 | 类型 | 说明 |',
    '| :--- | :--- | :--- |',
    '| a.ts | 修改 | x |',
    '| b.ts | 新增 | y |',
  ].join(String.fromCharCode(10))
  const r = parseDeclaredChanges(text)
  assert.equal(r.length, 2)
  assert.equal(r[0].path, 'a.ts')
  assert.equal(r[1].path, 'b.ts')
})

test('parseDeclaredCommands: 列表项抽取', () => {
  const text = [
    '### 验证结果',
    '',
    '- pnpm test:unit → 108 通过',
    '- pnpm tsc → 通过',
  ].join(String.fromCharCode(10))
  const r = parseDeclaredCommands(text)
  assert.equal(r.length, 2)
  assert.equal(r[0], 'pnpm test:unit → 108 通过')
})

test('runSelfcheck: 两判据全通过 → verdict=pass', () => {
  const r = runSelfcheck({ doneText: '', actualChanges: [], observedCommands: [] })
  assert.equal(r.verdict, 'pass')
  assert.equal(r.level, 'L0')
})

test('runSelfcheck: 命令造假样本 → verdict=fail', () => {
  const doneText = [
    '### 验证结果',
    '',
    '- pnpm test:unit',
  ].join(String.fromCharCode(10))
  const r = runSelfcheck({ doneText, actualChanges: [], observedCommands: [] })
  assert.equal(r.verdict, 'fail')
})

test('G6: 超时降级 → level=L0 + degraded 标注', async () => {
  const { degradeResult } = await import('../src/selfcheck/executor.js')
  const base = runSelfcheck({ doneText: '', actualChanges: [], observedCommands: [] })
  const r = degradeResult(base, '120s 超时，跳过 L1')
  assert.equal(r.level, 'L0')
  assert.equal(r.degraded, '120s 超时，跳过 L1')
  assert.equal(r.verdict, base.verdict)
})

test('L1 pickTsTargets: core 改动 → tsconfig.json', async () => {
  const { pickTsTargets } = await import('../src/selfcheck/regression.js')
  assert.deepEqual(pickTsTargets(['packages/core/src/x.ts']), ['tsconfig.json'])
})

test('L1 pickTsTargets: client 改动 → tsconfig.client.json', async () => {
  const { pickTsTargets } = await import('../src/selfcheck/regression.js')
  assert.deepEqual(pickTsTargets(['packages/client/App.vue']), ['tsconfig.client.json'])
})

test('L1 pickTsTargets: 多面改动 → 多个 target', async () => {
  const { pickTsTargets } = await import('../src/selfcheck/regression.js')
  const t = pickTsTargets(['packages/core/a.ts', 'packages/client/b.ts'])
  assert.ok(t.includes('tsconfig.json'))
  assert.ok(t.includes('tsconfig.client.json'))
})

test('L1 pickTsTargets: 无相关改动 → 空数组', async () => {
  const { pickTsTargets } = await import('../src/selfcheck/regression.js')
  assert.deepEqual(pickTsTargets(['docs/x.md']), [])
})

// [A-REQ-4] 缺口②：runRegression 核心判据「只拦新增 error」承重用例（注入假计数器，不跑真 tsc/eslint）
test('L1 runRegression: 无相关改动 → 单条 skipped ok', async () => {
  const { runRegression } = await import('../src/selfcheck/regression.js')
  const items = await runRegression(['docs/x.md'], { tsc: { errors: 0 } }, { tscErrors: async () => 0, lintErrors: async () => 0 })
  assert.equal(items.length, 1)
  assert.equal(items[0].ok, true)
  assert.ok(items[0].details?.some(d => d.includes('[skipped]')))
})

test('L1 runRegression: 缺 baseline → skipped ok', async () => {
  const { runRegression } = await import('../src/selfcheck/regression.js')
  const items = await runRegression(['packages/core/a.ts'], null, { tscErrors: async () => 0, lintErrors: async () => 0 })
  assert.equal(items.length, 1)
  assert.equal(items[0].ok, true)
  assert.ok(items[0].details?.some(d => d.includes('[skipped]')))
})

test('L1 runRegression: tsc 命令失败(-1) → skipped ok（fail-open）', async () => {
  const { runRegression } = await import('../src/selfcheck/regression.js')
  const items = await runRegression(['packages/core/a.ts'], { tsc: { errors: 0 } }, { tscErrors: async () => -1, lintErrors: async () => 0 })
  const it = items.find(i => i.id === 'L1-tsc-tsconfig.json')
  assert.equal(it?.ok, true)
  assert.ok(it?.details?.some(d => d.includes('[skipped]')))
})

test('L1 runRegression: errors <= baseline → pass', async () => {
  const { runRegression } = await import('../src/selfcheck/regression.js')
  const items = await runRegression(['packages/core/a.ts'], { tsc: { errors: 5 } }, { tscErrors: async () => 3, lintErrors: async () => 0 })
  const it = items.find(i => i.id === 'L1-tsc-tsconfig.json')
  assert.equal(it?.ok, true)
  assert.equal(it?.actual, '3 errors')
})

test('L1 runRegression: 新增错误 > baseline → fail（承重核心：比较条件改恒真则本用例必红）', async () => {
  const { runRegression } = await import('../src/selfcheck/regression.js')
  const items = await runRegression(['packages/core/a.ts'], { tsc: { errors: 2 } }, { tscErrors: async () => 5, lintErrors: async () => 0 })
  const it = items.find(i => i.id === 'L1-tsc-tsconfig.json')
  assert.equal(it?.ok, false)
  assert.ok(it?.details?.some(d => d.includes('3')))
})

test('L1 runRegression: lint 新增 error → L1-lint fail', async () => {
  const { runRegression } = await import('../src/selfcheck/regression.js')
  const items = await runRegression(['packages/core/a.ts'], { tsc: { errors: 0 }, lint: { errors: 0 } }, { tscErrors: async () => 0, lintErrors: async () => 4 })
  const it = items.find(i => i.id === 'L1-lint')
  assert.equal(it?.ok, false)
  assert.ok(it?.details?.some(d => d.includes('lint error')))
})

test('L1 runRegression: lint 命令失败(-1) → L1-lint skipped ok', async () => {
  const { runRegression } = await import('../src/selfcheck/regression.js')
  const items = await runRegression(['packages/core/a.ts'], { tsc: { errors: 0 } }, { tscErrors: async () => 0, lintErrors: async () => -1 })
  const it = items.find(i => i.id === 'L1-lint')
  assert.equal(it?.ok, true)
  assert.ok(it?.details?.some(d => d.includes('[skipped]')))
})

test('L1 runRegression: lint 干净 → L1-lint pass', async () => {
  const { runRegression } = await import('../src/selfcheck/regression.js')
  const items = await runRegression(['packages/client/a.vue'], { tsc: { errors: 0 }, lint: { errors: 0 } }, { tscErrors: async () => 0, lintErrors: async () => 0 })
  const it = items.find(i => i.id === 'L1-lint')
  assert.equal(it?.ok, true)
})
