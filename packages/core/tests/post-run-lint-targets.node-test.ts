// AIRUNNER-BATCH24-3-WEB-SERVER: server 侧测试（原 test/post-run-lint-targets.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/post-run-lint-targets.node-test.ts 迁至 test/post-run-lint-targets.node-test.ts
// AIRUNNER-BATCH22-1-CONSOLIDATE: 从 src/post-run/lint-targets.node-test.ts 迁至 client/test/post-run-lint-targets.node-test.ts
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LINT_EXTS, LINT_SKIP_SEGMENTS, pickLintTargets } from '../../../packages/core/src/post-run/lint-targets.js'

function ch(path: string, type: 'added' | 'modified' | 'deleted') { return { path, type } }

/** 仓库根：本文件在 packages/core/tests/ ⇒ 上三级 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

test('空数组 → 空数组', () => {
  assert.deepEqual(pickLintTargets([]), [])
})

test('deleted 条目被排除', () => {
  assert.deepEqual(pickLintTargets([ch('a.ts', 'deleted'), ch('b.ts', 'added')]), ['b.ts'])
})

test('保留 8 类扩展名（含 .md）', () => {
  const r = pickLintTargets([
    ch('a.ts', 'added'),
    ch('b.tsx', 'added'),
    ch('c.vue', 'added'),
    ch('d.js', 'added'),
    ch('e.jsx', 'added'),
    ch('f.mjs', 'added'),
    ch('g.cjs', 'added'),
    ch('i.md', 'added'),
    ch('h.json', 'added'),
  ])
  assert.deepEqual(r, ['a.ts', 'b.tsx', 'c.vue', 'd.js', 'e.jsx', 'f.mjs', 'g.cjs', 'i.md'])
})

test('大写扩展名被识别', () => {
  assert.deepEqual(pickLintTargets([ch('A.TS', 'added'), ch('B.VUE', 'added')]), ['A.TS', 'B.VUE'])
})

test('LINT_EXTS 精确值', () => {
  assert.deepEqual([...LINT_EXTS].sort(), ['.cjs', '.js', '.jsx', '.md', '.mjs', '.ts', '.tsx', '.vue'])
})

test('无扩展名不通过', () => {
  assert.deepEqual(pickLintTargets([ch('Makefile', 'added')]), [])
})

test('混合场景', () => {
  const r = pickLintTargets([
    ch('src/a.ts', 'added'),
    ch('src/b.ts', 'deleted'),
    ch('client/x.vue', 'modified'),
    ch('docs/y.md', 'added'),
  ])
  assert.deepEqual(r, ['src/a.ts', 'client/x.vue', 'docs/y.md'])
})

// ── [lint-targets-md-v1] 以下三例守卫「.md 落盘即自检」这条结构性修复 ──
// 承重性：把 `.md` 从 LINT_EXTS 删掉 → 前两例立刻变红（这是 D11 根本形态的判据，不是装饰）。

test('[承重] markdown 变更必须进入 lint 目标（D11 根本形态）', () => {
  // 未对齐的 markdown 表格是 format/prettier error，只有把该文件传给 runEslint（带 --fix）才会被修
  assert.deepEqual(pickLintTargets([ch('docs/defect-review-verification.md', 'modified')]), ['docs/defect-review-verification.md'])
  assert.deepEqual(pickLintTargets([ch('.github/PULL_REQUEST_TEMPLATE.md', 'added')]), ['.github/PULL_REQUEST_TEMPLATE.md'])
})

test('[承重] eslint ignores 覆盖的目录不传给 eslint（纯噪声，且会让 lint.ok 语义变模糊）', () => {
  const r = pickLintTargets([
    ch('packages/client/test-results/1/error-context.md', 'added'),
    ch('.ai-runner/lessons.md', 'modified'),
    ch('node_modules/foo/README.md', 'modified'),
    ch('packages/core/dist/README.md', 'modified'),
    ch('coverage/x.md', 'modified'),
    ch('packages/client/e2e/playwright-report/a.md', 'modified'),
    ch('docs/keep.md', 'modified'),
  ])
  assert.deepEqual(r, ['docs/keep.md'])
})

test('[承重] 跳过集合与 eslint.config.ts 的 ignores 不漂移', () => {
  const src = fs.readFileSync(path.join(ROOT, 'eslint.config.ts'), 'utf8')
  const m = src.match(/ignores:\s*\[([^\]]*)\]/)
  assert.ok(m, 'eslint.config.ts 里必须能解析出 ignores 数组')
  const entries = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1])
  assert.ok(entries.length >= 4, `ignores 条目数异常：${entries.length}`)
  // 目录型条目（`a/**` 或 `**/a/**`）⇒ 其目录名必须出现在 LINT_SKIP_SEGMENTS 里
  const dirs = entries
    .map(e => e.replace(/^\*\*\//, '').replace(/\/\*\*$/, ''))
    .filter(d => d && !d.includes('*'))
  for (const d of dirs) {
    assert.ok(LINT_SKIP_SEGMENTS.has(d), `eslint ignores 里的 \`${d}\` 未同步进 LINT_SKIP_SEGMENTS`)
  }
})
