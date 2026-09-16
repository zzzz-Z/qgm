#!/usr/bin/env node
// @desc: 改 .ai/ → .ai-runner/ 文本引用（目录已手动 mv），附备份与回滚
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const ROOT = process.cwd()
const TTY = Boolean(process.stdout.isTTY)
const c = (n, s) => (TTY ? `\u001B[${n}m${s}\u001B[0m` : s)
const ok = s => console.log(c(32, '✓'), s)
const skip = s => console.log(c(33, '!'), s)
const err = s => console.error(c(31, '✗'), s)
const head = s => console.log(c(36, '▶'), s)
const RUNNER_DIR = path.join(ROOT, '.ai-runner')
const BACKUP_DIR = path.join(RUNNER_DIR, 'backup')
const ROLLBACK = process.argv.includes('--rollback')

const TEXT_FILES = [
  'src/config.ts',
  'src/index.ts',
  'bin/check-status.cjs',
  'bin/recover.cjs',
  'bin/ai-ask.cjs',
  'skills/gen-script-rules.md',
  'client/components/GeneratePanel.vue',
  'README.md',
]

function precheck() {
  head('前置检查')
  if (!fs.existsSync(RUNNER_DIR)) {
    err('.ai-runner/ 不存在。先在终端跑：mv .ai .ai-runner')
    process.exit(1)
  }
  ok('.ai-runner/ 存在')
  if (fs.existsSync(path.join(ROOT, '.ai'))) {
    err('.ai/ 仍存在。先在终端跑：mv .ai .ai-runner')
    process.exit(1)
  }
  ok('.ai/ 已不存在')
}

function backup() {
  head('备份')
  fs.mkdirSync(BACKUP_DIR, { recursive: true })
  for (const rel of TEXT_FILES) {
    const src = path.join(ROOT, rel)
    const dst = path.join(BACKUP_DIR, rel)
    if (!fs.existsSync(src)) { skip(`${rel} 不存在`); continue }
    if (fs.existsSync(dst)) { skip(`备份 ${rel} 已存在`); continue }
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
    ok(`备份 ${rel}`)
  }
}

function rollback() {
  head('回滚')
  for (const rel of TEXT_FILES) {
    const bak = path.join(BACKUP_DIR, rel)
    if (!fs.existsSync(bak)) { skip(`无备份 ${rel}`); continue }
    fs.copyFileSync(bak, path.join(ROOT, rel))
    ok(`恢复 ${rel}`)
  }
  console.log('  目录回滚：mv .ai-runner .ai')
}

function patchText() {
  head('改引用')
  for (const rel of TEXT_FILES) {
    const p = path.join(ROOT, rel)
    if (!fs.existsSync(p)) { skip(`${rel} 不存在`); continue }
    let src = fs.readFileSync(p, 'utf8')
    const before = src
    // 顺序：先改带引号的裸 '.ai'，再改 '.ai/' 形式
    src = src.replace(/'\.ai'/g, `'.ai-runner'`)
    src = src.replace(/"\.ai"/g, `".ai-runner"`)
    src = src.split('.ai/').join('.ai-runner/')
    if (src === before) { skip(`${rel} 无变化`); continue }
    fs.writeFileSync(p, src)
    ok(`${rel} 已改`)
  }
}

function verify() {
  head('自检')
  let fail = 0
  // 1. 关键文件无裸 .ai/ 引用（排除 .ai-runner/）
  for (const rel of TEXT_FILES) {
    const p = path.join(ROOT, rel)
    if (!fs.existsSync(p)) { skip(`${rel} 不存在`); continue }
    const s = fs.readFileSync(p, 'utf8')
    const stripped = s.split('.ai-runner/').join('')
    if (stripped.includes('.ai/')) { err(`${rel} 仍含 .ai/`); fail++ }
    else ok(`${rel} 无裸 .ai/`)
  }
  // 2. EXCLUDE_PREFIX 已改
  const cfgPath = path.join(ROOT, 'src/config.ts')
  if (fs.existsSync(cfgPath)) {
    const cfg = fs.readFileSync(cfgPath, 'utf8')
    if (cfg.includes(`'.ai-runner'`)) ok(`src/config.ts EXCLUDE_PREFIX 已改`)
    else { err(`src/config.ts EXCLUDE_PREFIX 未改`); fail++ }
  }
  // 3. RUNS_DIR 等常量已改
  if (fs.existsSync(cfgPath)) {
    const cfg = fs.readFileSync(cfgPath, 'utf8')
    for (const k of ['RUNS_DIR', 'SCRIPTS_DIR', 'LOGS_DIR', 'BACKUP_DIR']) {
      const re = new RegExp(`${k}\\s*=\\s*path\\.join\\(ROOT,\\s*'\\.ai-runner`)
      if (re.test(cfg)) ok(`${k} 指向 .ai-runner/`)
      else { err(`${k} 未指向 .ai-runner/`); fail++ }
    }
  }
  if (fail) { err(`${fail} 项自检失败`); process.exit(1) }
  ok('全部自检通过')
}

function main() {
  if (ROLLBACK) { rollback(); return }
  head(`改 .ai 引用：${new Date().toISOString()}`)
  precheck()
  backup()
  patchText()
  verify()
  head('下一步')
  console.log('  跑：node bin/check-status.cjs  → 应全绿')
  console.log('  回滚：node fix-ai-refs.cjs --rollback && mv .ai-runner .ai')
}
try { main() } catch (e) { err(String(e && e.stack || e)); process.exit(1) }