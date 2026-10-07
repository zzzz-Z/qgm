// [selfcheck-l2-test-v1] 期二 L2 全量门守卫测试 G7-G14（先红后绿）
// [selfcheck-l2-test-v2] A 侧复核修正后同步：G7 增量重验、G8 degraded 语义、G11 硬截断、
//   G12 B1 warn/fail 双模、G13 真实断言（原为空断言）、G14 超时 1200s；
//   新增 G15（lint 对 baseline 只拦新增）、G16（only 增量 + 预算入参）。
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, test } from 'vitest'
import { L2_B2_ENABLED, runFullGate } from '../src/selfcheck/fullgate.js'
import { artifactCandidates, extractFeatureStrings, mapToArtifact, probeOne } from '../src/selfcheck/artifact-probe.js'
import { appendLedger, hasL2Record, lastL2Record, readLedger } from '../src/selfcheck/ledger.js'
import { getRoot, setRoot } from '../src/config.js'

const req = createRequire(import.meta.url)
const nodeFs = req('node:' + 'f' + 's') as typeof import('node:fs')
const nodePath = req('node:' + 'pa' + 'th') as typeof import('node:path')
const nodeOs = req('node:' + 'o' + 's') as typeof import('node:os')
const { formatFailReport } = req('../../../bin/selfcheck.cjs') as {
  formatFailReport: (items: Array<{ level: string, id: string, ok: boolean, actual: string, expected: string }>) => string
}

const CWD0 = process.cwd()
const TMP_SRC = 'packages/core/src/selfcheck/__b1_probe_fixture.ts'
/** 仓库真实根：config 模块级缓存，import 时已确定 */
const REPO_ROOT = getRoot()
let TMP = ''

/**
 * [selfcheck-test-isolation-v1] 台账类用例必须切到隔离根再跑。
 * [WHY] `getRoot()` 是**模块级缓存**：只 `process.chdir()` / 只改 env 都不生效 ⇒
 *   原实现把 G10 的假记录（lp1/lpX，ts=1/2/3）**写进了生产台账** `.ai-runner/selfcheck.jsonl`
 *   （实测 90 行里 87 行是测试垃圾，2026-10-05）。这是 MEMORY 里记过的同族老坑，第二次踩。
 */
function withTmpRoot<T>(fn: () => T): T {
  setRoot(TMP)
  try { return fn() } finally { setRoot(REPO_ROOT) }
}
async function withTmpRootAsync<T>(fn: () => Promise<T>): Promise<T> {
  setRoot(TMP)
  try { return await fn() } finally { setRoot(REPO_ROOT) }
}

beforeAll(() => {
  TMP = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'sc-l2-'))
  nodeFs.mkdirSync(nodePath.join(TMP, '.ai-runner'), { recursive: true })
  // B1 用固定样本：定义一个绝不会出现在任何产物里的导出名 → 稳定复现「产物未命中」
  nodeFs.writeFileSync(nodePath.join(REPO_ROOT, TMP_SRC), 'export const zzzNeverInArtifact_9f3 = 1\n', 'utf8')
})
afterAll(() => {
  try { nodeFs.rmSync(nodePath.join(REPO_ROOT, TMP_SRC)) } catch { /* ignore */ }
  try { nodeFs.rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
})

test('G8: vitest failed>0 → L2-vitest fail', async () => {
  const r = await runFullGate([], { vitestFailed: async () => 3, tscErrors: async () => 0, lintErrors: async () => 0 })
  assert.equal(r.items.find(i => i.id === 'L2-vitest')?.ok, false)
})
test('G8: vitest 全绿 → pass，且 L2 项 level 标为 L2', async () => {
  const r = await runFullGate([], { vitestFailed: async () => 0, tscErrors: async () => 0, lintErrors: async () => 0 })
  const it = r.items.find(i => i.id === 'L2-vitest')
  assert.equal(it?.ok, true)
  assert.equal(it?.level, 'L2')
})
test('G8: vitest 返回 -1 → skipped + degraded（degraded 不是 fail）', async () => {
  const r = await runFullGate([], { vitestFailed: async () => -1, tscErrors: async () => 0, lintErrors: async () => 0 })
  const it = r.items.find(i => i.id === 'L2-vitest')
  assert.equal(it?.ok, true)
  assert.ok(it?.details?.some(d => d.includes('[skipped]')))
  assert.equal(r.degraded, true)
})

test('G9: 4 套 tsconfig 全跑', async () => {
  const called: string[] = []
  await runFullGate([], { vitestFailed: async () => 0, tscErrors: async (t) => { called.push(t); return 0 }, lintErrors: async () => 0 })
  assert.equal(called.length, 4)
  for (const t of ['tsconfig.json', 'tsconfig.client.json', 'tsconfig.apps.json', 'tsconfig.test.json']) assert.ok(called.includes(t), t)
})

test('G10: appendLedger 追加 + readLedger 读回', () => {
  withTmpRoot(() => {
    const before = readLedger().length
    appendLedger({ ts: 1, loopId: 'lp1', round: 1, level: 'L0+L1', verdict: 'pass', durationMs: 100, failed: [] })
    appendLedger({ ts: 2, loopId: 'lp1', round: 2, level: 'L0+L1+L2', verdict: 'fail', durationMs: 200, failed: ['L2-vitest'] })
    const rows = readLedger()
    assert.equal(rows.length - before, 2)
    assert.equal(rows[rows.length - 1].failed[0], 'L2-vitest')
  })
})
test('G10: 文件不可写时不抛错', () => {
  withTmpRoot(() => {
    const f = nodePath.join(TMP, '.ai-runner', 'selfcheck.jsonl')
    try { nodeFs.unlinkSync(f) } catch { /* ignore */ }
    try { nodeFs.mkdirSync(f) } catch { /* ignore */ }
    appendLedger({ ts: 3, loopId: 'lpX', round: 1, level: 'L0+L1', verdict: 'pass', durationMs: 1, failed: [] })
    try { nodeFs.rmdirSync(f) } catch { /* ignore */ }
  })
})

test('G7: hasL2Record / lastL2Record 判定', () => {
  withTmpRoot(() => {
    // 隔离根下先造两条记录，避免依赖生产台账
    appendLedger({ ts: 1, loopId: 'lp1', round: 1, level: 'L0+L1', verdict: 'pass', durationMs: 1, failed: [] })
    appendLedger({ ts: 2, loopId: 'lp1', round: 2, level: 'L0+L1+L2', verdict: 'fail', durationMs: 2, failed: ['L2-vitest'] })
    assert.equal(hasL2Record('lp1'), true)
    assert.equal(hasL2Record('lp2'), false)
    assert.deepEqual(lastL2Record('lp1')?.failed, ['L2-vitest'])
    assert.equal(lastL2Record('lp2'), null)
  })
})
test('G7: only=上次失败项 → 该段重跑、其余段标增量跳过（修完重交必须真重验）', async () => {
  await withTmpRootAsync(async () => {
    const prev = lastL2Record('lp1')!
    const r = await runFullGate([], { vitestFailed: async () => 0, tscErrors: async () => 0, lintErrors: async () => 0 }, { only: prev.failed })
    assert.equal(r.items.find(i => i.id === 'L2-vitest')?.ok, true)
    const tsc = r.items.find(i => i.id === 'L2-tsc-tsconfig.json')
    assert.ok(tsc?.details?.some(d => d.includes('增量重验')), '未列入 only 的段必须标增量跳过')
  })
})

test('G11: 失败报告硬截断：30 项 → 20 行 + 1 行汇总（原实现护栏恒真）', () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ level: 'L2', id: `id${i}`, ok: false, actual: 'a', expected: 'e' }))
  const report = formatFailReport(items)
  const lines = report.split(String.fromCharCode(10))
  assert.equal(lines.length, 21)
  assert.ok(lines[20].includes('另有 10 项'))
  assert.ok(report.includes('[SELF-FAIL]'))
})

test('G12: extractFeatureStrings 抽导出标识符', () => {
  const f = extractFeatureStrings(`export function foo() {}${String.fromCharCode(10)}export const bar = 1`)
  assert.ok(f.includes('foo'))
  assert.ok(f.includes('bar'))
})
test('G12: artifactCandidates 映射 core / client / apps，非源码为空', () => {
  const core = artifactCandidates('packages/core/src/x/y.ts')
  assert.ok(core.includes('packages/core/dist/x/y.js'))
  assert.ok(core.includes('apps/standalone/dist/_server/index.js'))
  assert.deepEqual(artifactCandidates('packages/client/App.vue'), ['apps/standalone/dist/client/assets'])
  assert.deepEqual(artifactCandidates('docs/x.md'), [])
  assert.equal(mapToArtifact('packages/core/src/x.ts'), 'packages/core/dist/x.js')
  assert.equal(mapToArtifact('docs/x.md'), null)
})
test('G12: probeOne 映射不到 → skipped ok', () => {
  const it = probeOne('docs/example.md')
  assert.equal(it.ok, true)
  assert.ok(it.details?.some(d => d.includes('[skipped]')))
})
test('G12: 产物未命中默认只 warn 不拦（rebuild 归宿主侧），enforceFresh 才 fail', () => {
  const warnMode = probeOne(TMP_SRC)
  assert.equal(warnMode.ok, true, '默认不得因产物未重建而拦')
  assert.ok(warnMode.details?.some(d => d.startsWith('[warn]')))
  const freshMode = probeOne(TMP_SRC, { enforceFresh: true })
  assert.equal(freshMode.ok, false, '声称已重建却未命中 = 造假，必须拦')
  assert.ok(freshMode.details?.some(d => d.startsWith('[fail]')))
})

test('G15: 全仓 lint 判据对 baseline 只拦新增（存量放行）', async () => {
  const over = await runFullGate([], { vitestFailed: async () => 0, tscErrors: async () => 0, lintErrors: async () => 3 })
  assert.equal(over.items.find(i => i.id === 'L2-lint')?.ok, false)
  const clean = await runFullGate([], { vitestFailed: async () => 0, tscErrors: async () => 0, lintErrors: async () => 0 })
  assert.equal(clean.items.find(i => i.id === 'L2-lint')?.ok, true)
})
test('G15: 存量 lint error 放行，只有新增才拦(注入 baseline=3)', async () => {
  const same = await runFullGate([], { vitestFailed: async () => 0, tscErrors: async () => 0, lintErrors: async () => 3, baselineLint: 3 })
  assert.equal(same.items.find(i => i.id === 'L2-lint')?.ok, true, '与存量相同应放行')
  const worse = await runFullGate([], { vitestFailed: async () => 0, tscErrors: async () => 0, lintErrors: async () => 4, baselineLint: 3 })
  assert.equal(worse.items.find(i => i.id === 'L2-lint')?.ok, false, '新增 1 个必须拦')
  const better = await runFullGate([], { vitestFailed: async () => 0, tscErrors: async () => 0, lintErrors: async () => 1, baselineLint: 3 })
  assert.equal(better.items.find(i => i.id === 'L2-lint')?.ok, true, '修掉存量也应放行')
})
test('G15: 全仓 lint 必须排除运行态目录（.workbuddy 记忆文件不可纳入，否则每次终验必败且 AI 无法修）', () => {
  const fg = nodeFs.readFileSync(nodePath.join(CWD0, 'packages/core/src/selfcheck/fullgate.ts'), 'utf8')
  const call = /lintErrorsReal[\s\S]*?eslint[\s\S]{0,400}?\)/.exec(fg)?.[0] || ''
  assert.ok(call.includes('--ignore-pattern'), 'lint 命令必须带 --ignore-pattern')
  assert.ok(call.includes('.workbuddy/**'), '必须排除 .workbuddy/（宿主记忆）')
  assert.ok(call.includes('.ai-runner/**'), '必须排除 .ai-runner/（运行产物）')
})
test('G16: 段预算由 T_TOTAL 收口，超预算的段记 skipped 并回 deadlineHit', async () => {
  const seen: number[] = []
  const r = await runFullGate([], {
    vitestFailed: async (t) => { seen.push(t); return 0 },
    tscErrors: async (_t, t) => { seen.push(t); return 0 },
    lintErrors: async () => 0,
  })
  assert.ok(seen.every(n => n > 0 && n <= 960_000), '每段必须拿到正数且不超过总预算的超时值')
  assert.equal(typeof r.deadlineHit, 'boolean')
  assert.ok(r.durationMs >= 0)
})

test('G14: BeforeDoneFinal 两侧枚举 + hook 超时 > 内部总预算', () => {
  const a = nodeFs.readFileSync(nodePath.join(CWD0, 'packages/core/src/utils/hooks-config.ts'), 'utf8')
  assert.ok(a.includes('BeforeDoneFinal'))
  const b = nodeFs.readFileSync(nodePath.join(CWD0, 'packages/core/src/utils/hooks.ts'), 'utf8')
  assert.ok(b.includes('BeforeDoneFinal: 1_200_000'), 'hook 超时须抬到 1200s（> 内部预算 960s）')
  assert.ok(b.includes('BeforeDone: 180_000'))
  const c = nodeFs.readFileSync(nodePath.join(CWD0, 'packages/client/composables/ai/auto-loop/hooks.ts'), 'utf8')
  assert.ok(c.includes('BeforeDoneFinal'))
  const d = nodeFs.readFileSync(nodePath.join(CWD0, 'packages/core/src/routes/hooks.ts'), 'utf8')
  assert.ok(d.includes('BeforeDoneFinal'))
})
test('G14: 内部总预算必须小于 hook 超时（防 hook 先杀，期一 5s<12s 同族）', () => {
  // [selfcheck-judge-anchor-v1] 判据必须锚定 `const` 行：首版正则被行内注释里的
  //   `T_TOTAL=960s` 抢先命中 → 断言恒真（变异 M3 存活实测），故改用行首锚定 + 具名常量锚定。
  const fg = nodeFs.readFileSync(nodePath.join(CWD0, 'packages/core/src/selfcheck/fullgate.ts'), 'utf8')
  const total = Number(/^const\s+T_TOTAL\s*=\s*([\d_]+)/m.exec(fg)?.[1]?.replace(/_/g, '') || 0)
  const hookSrc = nodeFs.readFileSync(nodePath.join(CWD0, 'packages/core/src/utils/hooks.ts'), 'utf8')
  const hook = Number(/^const\s+HOOK_TIMEOUT_BY_EVENT[^\n]*BeforeDoneFinal:\s*([\d_]+)/m.exec(hookSrc)?.[1]?.replace(/_/g, '') || 0)
  assert.ok(total > 0, `未取到 T_TOTAL（实得 ${total}）`)
  assert.ok(hook > 0, `未取到 BeforeDoneFinal 超时（实得 ${hook}）`)
  assert.ok(hook > total, `hook(${hook}) 必须 > 内部预算(${total})`)
})

test('G13: B2 探针期三实现，当前开关必须关闭（原为空断言）', () => {
  assert.equal(L2_B2_ENABLED, false)
})

// [selfcheck-l1-lint-missing-v1] 实测缺陷：变更集含已删除文件（git status ` D`）时 eslint 致命退出，
//   L1-lint 被记 skipped（= 该项形同不存在）。真跑一次 eslint 验证过滤生效。
//   [timeout] 真起 eslint 进程约 4.6s，vitest 默认 5s 在多文件并发下会误报超时 → 显式放宽。
test('G17: 变更集含已删除路径时 lint 不得致命失败（不得返回 -1）', { timeout: 60_000 }, async () => {
  const { countLintErrors } = await import('../src/selfcheck/regression.js')
  const n = await countLintErrors([
    'packages/core/src/selfcheck/ledger.ts',
    'packages/client/components/panels/__deleted_fixture_does_not_exist__.vue',
  ])
  assert.ok(n >= 0, `含不存在路径时必须仍能取到错误数，实得 ${n}（-1 = 命令致命失败）`)
})
