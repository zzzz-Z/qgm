'use strict'
// HCLC 结构守卫 — 将 src/ 的 import 阈值固化为可回归断言
// 参考 skills/RULES.md 第7章：单文件 import 数 > 8 为阻断级
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'src')
const LIMIT = 8

// AIRUNNER-HCLC-SKIP-BARRELS
function isBarrel(file) {
  const base = path.basename(file)
  if (base === 'index.ts') return true
  if (path.relative(ROOT, file) === path.join('src', 'deps.ts')) return true
  return false
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') && !isBarrel(p)) out.push(p)
  }
  return out
}

function countImports(file) {
// AIRUNNER-HCLC-UNIQ-MODULES
  const src = fs.readFileSync(file, 'utf8')
  const mods = new Set()
  const re = /from\s+['"]([^'"]+)['"]/g
  let m
  while ((m = re.exec(src)) !== null) mods.add(m[1])
  return mods.size
}

test('HCLC: src/ 每个 .ts 的唯一 import 模块数 ≤ 8（阻断阈值）', () => {
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

test('HCLC: barrel 入口存在且非空', () => {
  const barrels = [
    'src/deps.ts',
    'src/routes/index.ts',
    'src/post-run/index.ts',
    'src/process/index.ts',
    'src/utils/index.ts',
  ]
  for (const b of barrels) {
    const p = path.join(ROOT, b)
    assert.ok(fs.existsSync(p), `barrel 缺失: ${b}`)
    const src = fs.readFileSync(p, 'utf8')
    assert.ok((src.match(/^export\s/gm) || []).length > 0, `barrel 无 export: ${b}`)
  }
})
