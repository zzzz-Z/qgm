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
  { name: 'test:unit', cmd: 'pnpm', args: ['test:unit'] },
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
const results = await Promise.all(TASKS.map(runOne))
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
