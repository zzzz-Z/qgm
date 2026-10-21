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
// [commit-subject-v1] 标题解析抽到 scripts/lib：入口只做 IO，守卫 import 同一套算法
const { parseCommitSubject } = require('../scripts/lib/commit-subject.cjs')

const ROOT = process.cwd()
const LOG = path.join(ROOT, '.ai-runner', 'post-done.log')

// [post-done-gate-v1] hook 经 stdin 传 {event, payload}；payload.doneSummary 是 DONE 摘要前 5 行。
// [WHY] commit msg 只写时间戳对 git log 无信息量；摘要让每次 checkpoint 自解释。
// [commit-subject-v1] 这里**只保留原文**，标题交给 parseCommitSubject 全权决定：
//   ① DONE 播报首行写了 `COMMIT: <type>(<scope>): <subject>` ⇒ 用它（conventional commit）；
//   ② 缺失或 type 非法 ⇒ 降级为既有的「chore(done): 摘要首段」。
//   原文里的双引号由 git 的数组参数通道兜住（execFileSync，不经 shell），此处不预转义。
let doneSummary = ''
try {
  const raw = fs.readFileSync(0, 'utf8')
  const j = JSON.parse(raw)
  doneSummary = String((j && j.payload && j.payload.doneSummary) || '')
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
  // [commit-subject-v1] 有 DONE 摘要则解析成 conventional commit 标题；无则回退时间戳。
  // [CONSTRAINT] 降级路径（source==='fallback'）要落日志：它意味着 AI 没按 §12 契约写 COMMIT: 行，
  //   是「契约未生效」的可观测信号，不是静默正常。
  let subject = `chore(auto): DONE checkpoint ${ts}`
  if (doneSummary) {
    const parsed = parseCommitSubject(doneSummary)
    subject = parsed.subject
    if (parsed.source === 'fallback') log(`commit subject 走降级路径（DONE 播报无合法 COMMIT: 行）`)
  }
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
