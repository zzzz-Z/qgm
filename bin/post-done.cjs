#!/usr/bin/env node
'use strict'
// [post-done-gate-v1] DONE 后置动作：commit 当前分支 → 后台 build + 延迟 restart。
// [WHY] 用户授权（2026-10-16）推翻原「方案 C（AI 改动不进分支）」与「重启归宿主」。
// [CONSTRAINT] build+restart 必须 detached 后台：本脚本由 5175 自身的 hook 执行，
//   同步 pm2 restart 会杀掉正在跑 hook 的进程 → DONE 回执与构建日志全丢（pm2-ecosystem-v1 已记录此风险）。
// [CHANGE-IMPACT] 每次 DONE 都会在当前分支产生一个 checkpoint commit；restart 约 5-10s 后生效。
const { execSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const LOG = path.join(ROOT, '.ai-runner', 'post-done.log')

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { fs.appendFileSync(LOG, line) } catch { /* 日志失败不阻断 */ }
  process.stdout.write(line)
}

function run(cmd) {
  try { return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  catch (e) { log(`FAIL: ${cmd} → exit ${e.status}`); return null }
}

try { fs.accessSync(path.join(ROOT, '.git')) } catch { log('no .git, skip'); process.exit(0) }

const status = run('git status --porcelain')
if (status === null) process.exit(0)

if (status.trim()) {
  run('git add -A')
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ')
  const c = run(`git commit -m "chore(auto): DONE checkpoint ${ts}"`)
  if (c === null) { log('commit failed (identity 未配置？)')
  }
  else { const h = run('git rev-parse --short HEAD'); log(`committed: ${(h || '').trim()}`) }
} else {
  log('no changes to commit')
}

// build + restart 后台执行，不阻塞 DONE 回执
const child = spawn('sh', ['-c', 'pnpm build && pm2 restart ai-runner'], {
  detached: true,
  stdio: 'ignore',
  cwd: ROOT,
})
child.unref()
log(`bg build+restart started (pid ${child.pid})`)
process.exit(0)
