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
