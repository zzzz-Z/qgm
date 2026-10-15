#!/usr/bin/env node
'use strict'
// [post-done-gate-v1] DONE 后置动作：commit 当前分支 → 后台 build + 延迟 restart。
// [WHY] 用户授权（2026-10-16）推翻原「方案 C（AI 改动不进分支）」与「重启归宿主」。
// [CONSTRAINT] build+restart 必须 detached 后台：本脚本由 5175 自身的 hook 执行，
//   同步 pm2 restart 会杀掉正在跑 hook 的进程 → DONE 回执与构建日志全丢（pm2-ecosystem-v1 已记录此风险）。
// [CHANGE-IMPACT] 每次 DONE 都会在当前分支产生一个 checkpoint commit；restart 约 5-10s 后生效。
const { execSync, execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const LOG = path.join(ROOT, '.ai-runner', 'post-done.log')

// [post-done-gate-v1] hook 经 stdin 传 {event, payload}；payload.doneSummary 是 DONE 摘要前 5 行。
// [WHY] commit msg 只写时间戳对 git log 无信息量；摘要让每次 checkpoint 自解释。
// [CONSTRAINT] 摘要可能含多行/特殊字符 → 只取首行、截断、转义双引号。
let doneSummary = ''
try {
  const raw = fs.readFileSync(0, 'utf8')
  const j = JSON.parse(raw)
  const s = String((j && j.payload && j.payload.doneSummary) || '')
  // [post-done-gate-v1] 客户端用 ' / ' 拼多行；剥离 markdown 标题前缀，取首个有意义片段
  const segs = s.split(' / ').map(x => x.trim()).filter(x => x.length > 0)
  // [post-done-gate-v1] 优先取非标题片段（"## 结论" 剥 # 后只剩 "结论"，对 git log 无信息量）
  const first = segs.find(x => !/^#/.test(x)) || (segs[0] || '').replace(/^#+\s*/, '')
  doneSummary = first.replace(/"/g, '\'').slice(0, 120)
} catch { /* 无 stdin / 非法 JSON：回退时间戳 msg */ }

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
  // [post-done-gate-v1] 有 DONE 摘要则用它作 subject（可读）；无则回退时间戳。
  const subject = doneSummary ? `chore(done): ${doneSummary}` : `chore(auto): DONE checkpoint ${ts}`
  // [post-done-gate-v1] 数组参数走 execFileSync：subject 里的反引号/引号不被 shell 解析
  //   （原 execSync(git commit -m "...") 遇反引号触发 command substitution → exit 2 → 从未产生 commit）
  let c = null
  try {
    c = execFileSync('git', ['commit', '-m', subject], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) { log(`FAIL: git commit → exit ${e.status}`) }
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
