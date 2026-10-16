// AIRUNNER-BATCH27-2-HCLC-FN
// AIRUNNER-BATCH26-9-HCLC
// AIRUNNER-BATCH26-2-FIX-REQUIRE
// AIRUNNER-BATCH26-CJS-TO-VITEST: 从 src/hclc-guard.test.cjs 迁至 test/server/hclc-guard.test.ts
// HCLC 结构守卫 — 将 src/ 的 import 阈值固化为可回归断言
// 参考 SYSTEM.md §4（架构红线）：单文件 import 数 > 20 为阻断级
// [cohesion-over-budget-v1] 2026-10-06：阈值 8 → 20。原值贴着实测上限（4 个文件恰好 8），
//   逼出的是「为少一条 import 就绕道」的写法（内联 `typeof import()`、把类型经无关模块再导出），
//   而不是更少的依赖。放宽后仍拦得住真正的依赖枢纽（依赖方向另由 workspace-guard 守）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

// AIRUNNER-BATCH26-CJS-TO-VITEST: CJS __dirname 等价写法
import { fileURLToPath } from 'node:url'

import { it } from 'vitest'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// AIRUNNER-BATCH26-5-FIX-PATH-HCLC: 测试在 test/server/，源根在 ../../
// [mig-path-v1] 测试从 test/server/ 迁到 packages/core/tests/，__dirname 深一级 → ROOT 需 3 级上溯
const ROOT = path.resolve(__dirname, '..', '..', '..')
// [hclc-client-v1] 2026-10-17：扩范围至 packages/client。§4 原文「单文件唯一 import 模块数 > 20」
//   未限定 core；实测 packages/client/composables/ai/useAiReplyHandlers.ts 曾达 21 越线，
//   而原守卫只扫 packages/core/src ⇒ 该违规静默通过。先拆到 18 再扩，否则守卫一上即红。
const SRC_ROOTS = [
  path.join(ROOT, 'packages', 'core', 'src'),
  path.join(ROOT, 'packages', 'client'),
]
const LIMIT = 20
/** [hclc-skip-dirs] 遍历时跳过的目录：构建产物 / 运行态 / 测试与 e2e（后者不是业务代码） */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.ai-runner', 'tests', 'e2e', '__tests__'])

// AIRUNNER-HCLC-SKIP-BARRELS
function isBarrel(file: string) {
  const base = path.basename(file)
  if (base === 'index.ts') return true
  if (path.relative(ROOT, file) === path.join('packages', 'core', 'src', 'deps.ts')) return true
  return false
}

function walk(dir: string, out: string[] = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if ((e.name.endsWith('.ts') || e.name.endsWith('.vue')) && !e.name.endsWith('.d.ts') && !isBarrel(p)) out.push(p)
  }
  return out
}

function countImports(file: string) {
// AIRUNNER-HCLC-UNIQ-MODULES
  let src = fs.readFileSync(file, 'utf8')
  // [hclc-sfc-strip-v1] .vue 只数 <script> 内的 import：<template>/<style> 里的 `from "..."`
  //   不是依赖声明（含 `` 代码示例 / CSS 属性值等）；用 SFC 块正则在扫描前剥离。
  if (file.endsWith('.vue')) {
    const m = src.match(/<script[^>]*>([\s\S]*?)<\/script>/)
    src = m ? m[1] : ''
  }
  const mods = new Set()
  // [hclc-side-effect-import-v1] 2026-10-17 变异测试暴露：原正则只匹配 `from "x"` 形态，
  //   `import "x"`（side-effect，无 from）整批漏数 ⇒ 加一条 import 分支；Set 天然去重。
  const re = /(?:from|import)\s+['"]([^'"]+)['"]/g
  let m
  while ((m = re.exec(src)) !== null) mods.add(m[1])
  return mods.size
}

it('hCLC: 每个业务文件的唯一 import 模块数 ≤ 20（阻断阈值）', () => {
  const files: string[] = []
  for (const root of SRC_ROOTS) files.push(...walk(root))
  assert.ok(files.length >= 100, `两个根目录应至少有 100 个业务文件（排除 barrel 后当前 ${files.length}）`)

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
