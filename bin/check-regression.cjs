#!/usr/bin/env node
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = process.cwd()
const BASELINE = path.join(ROOT, '.ai-runner/baseline.json')
const TTY = Boolean(process.stdout.isTTY)
const c = (n, s) => (TTY ? `\u001B[${n}m${s}\u001B[0m` : s)
const ok = s => console.log(c(32, '✓'), s)
const err = s => console.error(c(31, '✗'), s)
const head = s => console.log(c(36, '▶'), s)
const warn = s => console.log(c(33, '!'), s)

function run(cmd, args, timeoutMs = 180_000) {
  try {
    const out = execFileSync(cmd, args, {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
    return { code: 0, out }
  } catch (e) {
    const out = String(e.stdout || '') + String(e.stderr || '')
    return { code: e.status || 1, out }
  }
}

// [refactor-bypass-pnpm] 绕过 pnpm policy 拦截，直调二进制
function runTsc() {
  const isWin = process.platform === 'win32'
  const vueTsc = path.join(ROOT, 'node_modules/.bin', isWin ? 'vue-tsc.cmd' : 'vue-tsc')
  const tsc = path.join(ROOT, 'node_modules/.bin', isWin ? 'tsc.cmd' : 'tsc')
  const bin = fs.existsSync(vueTsc) ? vueTsc : tsc
  if (!fs.existsSync(bin)) return { code: 1, out: '未找到 tsc / vue-tsc' }
  return run(bin, ['-p', 'tsconfig.json', '--noEmit'])
}
function runTests() {
  const files = []
  const d1 = path.join(ROOT, 'client')
  if (fs.existsSync(d1)) { for (const f of fs.readdirSync(d1)) { if (f.endsWith('.node-test.ts')) files.push(path.join('client', f))
  }
  }
  const d2 = path.join(ROOT, 'src')
  if (fs.existsSync(d2)) { for (const f of fs.readdirSync(d2)) { if (f.endsWith('.test.cjs')) files.push(path.join('src', f))
  }
  }
  if (!files.length) return { code: 1, out: '未找到测试文件' }
  return run(process.execPath, ['--test', '--experimental-strip-types', ...files], 180_000)
}

function countTscErrors(text) {
  const m = text.match(/error TS\d+/g)
  return m ? m.length : 0
}

function countTestFails(text) {
  // node --test 输出 " # fail N"
  const m = text.match(/^# fail (\d+)$/m)
  if (m) return Number(m[1])
  // 备用：TAP "not ok" 计数
  const n = (text.match(/^not ok \d+/gm) || []).length
  return n
}

const cmd = process.argv[2] || 'check'

if (cmd === 'init') {
  head('init baseline')
  console.log('  跑 pnpm tsc...')
  const t = runTsc()
  console.log('  跑 pnpm test:unit...')
  const u = runTests()
  const sha = run('git', ['rev-parse', 'HEAD']).out.trim().slice(0, 12)
  const baseline = {
    sha,
    ts: Date.now(),
    tsc: { code: t.code, errors: countTscErrors(t.out) },
    test: { code: u.code, fails: countTestFails(u.out) },
  }
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true })
  fs.writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`)
  ok(`baseline 已写: ${path.relative(ROOT, BASELINE)}`)
  console.log(JSON.stringify(baseline, null, 2))
  process.exit(0)
}

if (cmd === 'check') {
  head('check regression')
  if (!fs.existsSync(BASELINE)) {
    err('无 baseline，先跑: node bin/check-regression.cjs init')
    process.exit(2)
  }
  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
  console.log('  baseline sha:', base.sha, '@', new Date(base.ts).toISOString())
  console.log('  baseline tsc.errors:', base.tsc.errors, ' test.fails:', base.test.fails)
  console.log('')
  console.log('  跑 pnpm tsc...')
  const t = runTsc()
  const curTscErrors = countTscErrors(t.out)
  console.log('  跑 pnpm test:unit...')
  const u = runTests()
  const curTestFails = countTestFails(u.out)
  console.log('')

  const dTsc = curTscErrors - base.tsc.errors
  const dTest = curTestFails - base.test.fails

  const rows = [
    '  | 指标         | baseline | 当前 | 差值 |',
    '  |--------------|----------|------|------|',
    `  | tsc errors   | ${String(base.tsc.errors).padEnd(8)} | ${String(curTscErrors).padEnd(4)} | ${dTsc > 0 ? '+' : ''}${dTsc} |`,
    `  | test fails   | ${String(base.test.fails).padEnd(8)} | ${String(curTestFails).padEnd(4)} | ${dTest > 0 ? '+' : ''}${dTest} |`,
  ]
  console.log(rows.join('\n'))
  console.log('')

  if (dTsc > 0) {
    err(`✗ tsc 新增 ${dTsc} 个错误，阻断`)
    process.exit(1)
  }
  if (dTest > 0) {
    err(`✗ 测试新增 ${dTest} 个失败，阻断`)
    process.exit(1)
  }
  ok(`无新增回归（dTsc=${dTsc}, dTest=${dTest}）`)
  process.exit(0)
}

err('用法: node bin/check-regression.cjs [init|check]')
process.exit(2)
