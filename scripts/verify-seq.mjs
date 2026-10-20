#!/usr/bin/env node
// @desc 串行跑全部闸门（与原 `pnpm verify` 顺序一致），每步打印耗时，失败即停
// @why 原 `a && b && c` 串联看不到各步耗时，排查瓶颈时只能靠猜。
//   [CONSTRAINT] 语义必须与原 verify 完全一致：顺序相同、首个失败即停、退出码透传。
//   [WHY 不并行] 实测本机（16 核但供电 60W）并行 9 项要 86-94s，串行只要 64s——
//     多任务争抢反而更慢。并行的价值只在「一次拿到全部失败项」，见 verify-parallel.mjs。

import { spawnSync } from 'node:child_process'

const STEPS = [
  ['anchors:verify', 'anchors'],
  ['docs:verify', 'docs'],
  ['crossfile:verify', 'crossfile'],
  ['typecheck', 'typecheck（四套 tsc）'],
  ['lint', 'lint'],
  ['test:unit', 'unit test'],
]

const t0 = Date.now()
for (const [script, label] of STEPS) {
  const s = Date.now()
  console.log(`\n▶ ${label}`)
  const r = spawnSync('pnpm', [script], { stdio: 'inherit', shell: process.platform === 'win32' })
  const ms = Date.now() - s
  console.log(`  ${r.status === 0 ? '✓' : '✗'} ${label}  ${(ms / 1000).toFixed(1)}s`)
  if (r.status !== 0) {
    console.log(`\n总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s（在 ${label} 处中止）`)
    process.exit(r.status ?? 1)
  }
}
console.log(`\n✓ 全部通过，总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
