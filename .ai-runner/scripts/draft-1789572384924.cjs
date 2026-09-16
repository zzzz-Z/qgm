#!/usr/bin/env node
// @desc: ScriptPanel.vue 的 cm-host div 加 tabindex + @keydown.ctrl.enter/@keydown.meta.enter 兜底，附备份与回滚
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
const BACKUP_DIR = path.join(ROOT, '.ai-runner/backup')
const TARGET = path.join(ROOT, 'client/components/ScriptPanel.vue')
const BACKUP = path.join(BACKUP_DIR, 'client/components/ScriptPanel.vue')
const ROLLBACK = process.argv.includes('--rollback')

const ANCHOR = `<div ref="cmHost" class="cm-host" />`
const INSERT = `<div
            ref="cmHost"
            class="cm-host"
            tabindex="0"
            @keydown.ctrl.enter.prevent="runSmart"
            @keydown.meta.enter.prevent="runSmart"
          />`

function backup() {
  head('备份')
  fs.mkdirSync(BACKUP_DIR, { recursive: true })
  if (fs.existsSync(BACKUP)) { skip('备份已存在'); return }
  fs.copyFileSync(TARGET, BACKUP)
  ok('备份 → .ai-runner/backup/client/components/ScriptPanel.vue')
}

function rollback() {
  head('回滚')
  if (!fs.existsSync(BACKUP)) { err('无备份'); process.exit(1) }
  fs.copyFileSync(BACKUP, TARGET)
  ok('ScriptPanel.vue 已恢复')
}

function patch() {
  head('ScriptPanel.vue')
  const src = fs.readFileSync(TARGET, 'utf8')
  if (src.includes('@keydown.ctrl.enter')) { skip('已打过补丁'); return }
  if (!src.includes(ANCHOR)) { err('锚点未命中：cm-host div'); process.exit(1) }
  fs.writeFileSync(TARGET, src.replace(ANCHOR, INSERT))
  ok('cm-host 加 @keydown 兜底')
}

function verify() {
  head('自检')
  
  let fail = 0
  const src = fs.readFileSync(TARGET, 'utf8')
  for (const [s, label] of [
    [`@keydown.ctrl.enter.prevent="runSmart"`, 'Ctrl+Enter'],
    [`@keydown.meta.enter.prevent="runSmart"`, 'Cmd+Enter'],
    [`tabindex="0"`, 'tabindex'],
    [`key: 'Mod-Enter'`, 'CodeMirror keymap 保留'],
  ]) {
    if (src.includes(s)) ok(label)
    else { err(`缺 ${label}`); fail++ }
  }
  if (fail) { err(`${fail} 项自检失败`); process.exit(1) }
  ok('全部自检通过')
}

function main() {
  if (ROLLBACK) { rollback(); return }
  head(`patch ScriptPanel.vue：${new Date().toISOString()}`)
  if (!fs.existsSync(TARGET)) { err('ScriptPanel.vue 不存在'); process.exit(1) }
  backup()
  patch()
  verify()
  head('下一步')
  console.log('  1. HMR 自动重载')
  console.log('  2. 光标进编辑器，按 Ctrl/Cmd+Enter → runSmart')
  console.log('  回滚：node patch-editor-keydown.cjs --rollback')
}
try { main() } catch (e) { err(String(e && e.stack || e)); process.exit(1) }