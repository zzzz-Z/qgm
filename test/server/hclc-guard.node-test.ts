// AIRUNNER-BATCH27-2-HCLC-FN
// AIRUNNER-BATCH26-9-HCLC
// AIRUNNER-BATCH26-2-FIX-REQUIRE
// AIRUNNER-BATCH26-CJS-TO-VITEST: 从 src/hclc-guard.test.cjs 迁至 test/server/hclc-guard.test.ts
// HCLC 结构守卫 — 将 src/ 的 import 阈值固化为可回归断言
// 参考 skills/RULES.md 第7章：单文件 import 数 > 8 为阻断级
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

// AIRUNNER-BATCH26-CJS-TO-VITEST: CJS __dirname 等价写法
import { fileURLToPath } from 'node:url'

import { it } from 'vitest'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// AIRUNNER-BATCH26-5-FIX-PATH-HCLC: 测试在 test/server/，源根在 ../../
const ROOT = path.resolve(__dirname, '..', '..')
const SRC = path.join(ROOT, 'packages', 'core', 'src')
const LIMIT = 8

// AIRUNNER-HCLC-SKIP-BARRELS
function isBarrel(file: string) {
  const base = path.basename(file)
  if (base === 'index.ts') return true
  if (path.relative(ROOT, file) === path.join('packages', 'core', 'src', 'deps.ts')) return true
  return false
}

function walk(dir: string, out: string[] = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') && !isBarrel(p)) out.push(p)
  }
  return out
}

function countImports(file: string) {
// AIRUNNER-HCLC-UNIQ-MODULES
  const src = fs.readFileSync(file, 'utf8')
  const mods = new Set()
  const re = /from\s+['"]([^'"]+)['"]/g
  let m
  while ((m = re.exec(src)) !== null) mods.add(m[1])
  return mods.size
}

it('hCLC: src/ 每个 .ts 的唯一 import 模块数 ≤ 8（阻断阈值）', () => {
  const files = walk(SRC)
  assert.ok(files.length >= 40, `src/ 应至少有 40 个业务 .ts 文件（排除 barrel 后当前 ${files.length}）`)

  const bad = []
  for (const f of files) {
    const n = countImports(f)
    if (n > LIMIT) bad.push({ n, f: path.relative(ROOT, f) })
  }

  assert.equal(
    bad.length,
    0,
    `以下文件唯一 import 模块数超过 ${LIMIT}（HCLC 阻断）：\n${
      bad.map(x => `  ${x.n}  ${x.f}`).join('\n')}`,
  )
})

it('hCLC: barrel 入口存在且非空', () => {
  const barrels = [
    'packages/core/src/deps.ts',
    'packages/core/src/post-run/index.ts',
    'packages/core/src/process/index.ts',
    'packages/core/src/utils/index.ts',
  ]
  for (const b of barrels) {
    const p = path.join(ROOT, b)
    assert.ok(fs.existsSync(p), `barrel 缺失: ${b}`)
    const src = fs.readFileSync(p, 'utf8')
    assert.ok((src.match(/^export\s/gm) || []).length > 0, `barrel 无 export: ${b}`)
  }
})
