#!/usr/bin/env node
// @desc 并行跑全部验证（四套 tsc + lint + 单元测试），统一收集后报告
// @why pnpm typecheck 是串行 `&&`，四套 tsc 依次跑要几十秒；它们互不依赖，
//   并发后本仓实测 14s 完成（串行约 40-60s）。且串行首个失败即中断，
//   AI 一次只能看到一个错误；并行能一次拿到全部，减少返工轮次。
// [CONSTRAINT] 与 `pnpm verify` 不同：本脚本不跑 anchors/docs/crossfile（那些是闸门），
//   只并行「代码级」检查。退出码：全过 0，任一失败 1。

import { spawn } from 'node:child_process'

const TASKS = [
  { name: 'tsc', cmd: 'pnpm', args: ['tsc'] },
  { name: 'tsc:apps', cmd: 'pnpm', args: ['tsc:apps'] },
  { name: 'tsc:client', cmd: 'pnpm', args: ['tsc:client'] },
  { name: 'test:tsc', cmd: 'pnpm', args: ['test:tsc'] },
  { name: 'lint', cmd: 'pnpm', args: ['lint'] },
  // [vitest-shard-v1] 按包分片：config 把单进程 worker 限到 4（供电 60W 防 CPU 争抢误报），
  //   16 核机器因此闲置。两包互不依赖，各起一个 vitest（各 4 worker）实测稳定，64s → 30s。
  { name: 'test:core', cmd: 'npx', args: ['vitest', 'run', 'packages/core/tests'] },
  { name: 'test:client', cmd: 'npx', args: ['vitest', 'run', 'packages/client/tests'] },
]

function runOne(t) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const p = spawn(t.cmd, t.args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { out += d })
    p.on('close', code => resolve({ name: t.name, code: code ?? 1, ms: Date.now() - t0, out }))
    p.on('error', e => resolve({ name: t.name, code: 1, ms: Date.now() - t0, out: String(e) }))
  })
}

const t0 = Date.now()
// [verify-concurrency-cap-v1] 不一次性全起：7 个任务各开 worker 会超过机器承受力，
//   实测全并发 88.1s > 分批（≤4）的 30-40s。上限与 vitest 的 worker 数（4）对齐。
const MAX_PARALLEL = Number(process.env.VERIFY_PARALLEL) || 4
const results = []
for (let i = 0; i < TASKS.length; i += MAX_PARALLEL) {
  const batch = TASKS.slice(i, i + MAX_PARALLEL)
  results.push(...await Promise.all(batch.map(runOne)))
}
const total = Date.now() - t0

for (const r of results) {
  const tag = r.code === 0 ? '✓' : '✗'
  console.log(`${tag} ${r.name.padEnd(11)} ${String(r.code).padStart(3)}  ${(r.ms / 1000).toFixed(1)}s`)
}

const failed = results.filter(r => r.code !== 0)
console.log(`\n并行总耗时 ${(total / 1000).toFixed(1)}s；失败 ${failed.length}/${results.length}`)
if (failed.length > 0) {
  for (const f of failed) {
    console.log(`\n===== ${f.name} (exit ${f.code}) =====`)
    console.log(f.out.split('\n').slice(-40).join('\n'))
  }
  process.exit(1)
}
