#!/usr/bin/env node
// @desc: useAutoLoop.ts baseline 最小修复：补导出 + 补定义 + 清残留
// @why: c5fe711 缺 export/resolveInst/getActiveSessionId/sessionId，页面白屏；为能跑补最小集
// @plan: baseline 最小修复

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const TTY = Boolean(process.stdout.isTTY)
const C = { reset: TTY ? '\x1b[0m' : '', green: TTY ? '\x1b[32m' : '', yellow: TTY ? '\x1b[33m' : '', red: TTY ? '\x1b[31m' : '' }
const ok = m => console.log(C.green + '✓' + C.reset + ' ' + m)
const skip = m => console.log(C.yellow + '!' + C.reset + ' ' + m)
const err = m => console.error(C.red + '✗' + C.reset + ' ' + m)

const REL = 'client/composables/useAutoLoop.ts'
const ABS = path.join(ROOT, REL)
const BAK = path.join(ROOT, '.ai-runner/backup/baseline-minimal-fix/useAutoLoop.ts')

if (process.argv.includes('--rollback')) {
  if (!fs.existsSync(BAK)) { err('无备份：' + BAK); process.exit(1) }
  fs.copyFileSync(BAK, ABS); ok('已回滚 ' + REL); process.exit(0)
}

console.log('▶ 检查')
if (!fs.existsSync(ABS)) { err(REL + ' 不存在'); process.exit(1) }
const lines = fs.readFileSync(ABS, 'utf8').split('\n')

console.log('▶ 备份')
fs.mkdirSync(path.dirname(BAK), { recursive: true })
if (!fs.existsSync(BAK)) { fs.writeFileSync(BAK, lines.join('\n')); ok('备份 → ' + path.relative(ROOT, BAK)) }
else skip('备份已存在')

const touched = []

// A. 6 桩函数加 export
const NAMES = ['setActiveLoopSessionId', 'createLoopInstanceFor', 'removeLoopInstance', 'getLoopBySessionId', 'listActiveLoops', 'activeLoopsCount']
for (let i = 0; i < lines.length; i++) {
  for (const n of NAMES) {
    if (new RegExp('^const\\s+' + n + '\\b').test(lines[i])) {
      lines[i] = 'export ' + lines[i]
      touched.push('A: export const ' + n + ' @ ' + (i + 1))
    }
  }
}

// B. isInstActive 加 export
for (let i = 0; i < lines.length; i++) {
  if (/^function\s+isInstActive\s*\(/.test(lines[i])) {
    lines[i] = 'export ' + lines[i]
    touched.push('B: export function isInstActive @ ' + (i + 1))
  }
}

// E. inst.sessionId → ''
let cCount = 0
for (let i = 0; i < lines.length; i++) {
  if (/\binst\.sessionId\b/.test(lines[i])) {
    lines[i] = lines[i].replace(/\binst\.sessionId\b/g, "''")
    cCount++
  }
}
if (cCount) touched.push('E: inst.sessionId → \'\' (' + cCount + ' 处)')

// F. activeLoop.value?.sessionId 处理
let fCount = 0
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('activeLoop.value?.sessionId')) {
    if (/^\s*return\b/.test(lines[i])) lines[i] = lines[i].replace(/return\s+.+/, 'return true')
    else lines[i] = lines[i].split('activeLoop.value?.sessionId').join('undefined')
    fCount++
  }
}
if (fCount) touched.push('F: activeLoop.value?.sessionId (' + fCount + ' 处)')

// G. : LoopInstance | undefined → null
let gCount = 0
for (let i = 0; i < lines.length; i++) {
  if (/: LoopInstance \| undefined\b/.test(lines[i])) {
    lines[i] = lines[i].replace(/: LoopInstance \| undefined/g, ': LoopInstance | null')
    gCount++
  }
}
if (gCount) touched.push('G: | undefined → | null (' + gCount + ' 处)')

// C. resolveInst 补定义（在 activeLoop 声明之后插入）
if (!lines.some(l => /^(export\s+)?function\s+resolveInst\s*\(/.test(l))) {
  const anchor = lines.findIndex(l => /^const\s+activeLoop\s*=\s*computed/.test(l))
  if (anchor < 0) { err('C: 找不到 activeLoop 锚点'); process.exit(1) }
  lines.splice(anchor + 1, 0, '', 'function resolveInst(_sid?: string): LoopInstance | null {', '  return activeLoop.value', '}')
  touched.push('C: 补 resolveInst @ ' + (anchor + 2))
}

// D. getActiveSessionId 补声明
if (!lines.some(l => /^(let|var|const)\s+getActiveSessionId\b/.test(l))) {
  const anchor = lines.findIndex(l => /^const\s+activeLoop\s*=\s*computed/.test(l))
  if (anchor < 0) { err('D: 找不到 activeLoop 锚点'); process.exit(1) }
  lines.splice(anchor + 1, 0, '', "let getActiveSessionId: () => string = () => ''")
  touched.push('D: 补 getActiveSessionId @ ' + (anchor + 2))
}

if (!touched.length) { skip('全部已修，无需改动'); process.exit(0) }

console.log('▶ 改动清单')
for (const t of touched) ok(t)

const out = lines.join('\n')

console.log('▶ 自检')
const checks = [
  ['A: 6 桩全 export', NAMES.every(n => new RegExp('^export const ' + n + '\\b', 'm').test(out))],
  ['B: isInstActive export', /^export function isInstActive\s*\(/m.test(out)],
  ['C: resolveInst 定义', /^(export\s+)?function\s+resolveInst\s*\(/m.test(out)],
  ['D: getActiveSessionId 声明', /^(let|var|const)\s+getActiveSessionId\b/m.test(out)],
  ['E: 无 inst.sessionId', !/\binst\.sessionId\b/.test(out)],
  ['F: 无 activeLoop.value?.sessionId', !out.includes('activeLoop.value?.sessionId')],
  ['G: 无 : LoopInstance | undefined', !/: LoopInstance \| undefined\b/.test(out)],
  ['useAutoLoop 保留', /export\s+function\s+useAutoLoop\s*\(/.test(out)],
  ['activeLoop 保留', /const\s+activeLoop\s*=\s*computed/.test(out)],
]
let allOk = true
for (const [n, p] of checks) { if (p) ok(n); else { err(n); allOk = false } }
if (!allOk) { err('自检失败，磁盘未改动'); process.exit(1) }

fs.writeFileSync(ABS, out)
ok(REL + ' 已更新 (' + out.length + ' 字节)')
console.log('▶ 下一步：pnpm tsc；浏览器 Cmd+Shift+R 硬刷新')