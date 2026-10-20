#!/usr/bin/env node
/* eslint-disable no-console -- CLI 输出 */
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = process.cwd()
const BASELINE = path.join(ROOT, '.ai-runner/baseline.json')
const L = require('./_logger-shim.cjs')

const c = L.c
const ok = s => console.log(c(32, '✓'), s)
const err = s => console.error(c(31, '✗'), s)
const head = s => console.log(c(36, '▶'), s)

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

// [typecheck-single-entry] 走 package.json 的 typecheck 单入口
// WHY: 原先跑 `vue-tsc -p tsconfig.json`（core 配置），实际只覆盖 packages/core/src，
//   前端 + 测试的类型错误能悄悄绕过这道回归闸门
// CHANGE-IMPACT: 口径由「core only」变为「core + apps + client + test」，baseline 必须重建
function runTypecheck() {
  return run('pnpm', ['typecheck'], 600_000)
}

// [vitest-json-reporter] 用 vitest 的 json reporter 落盘后解析，不解析人类可读输出
// WHY: 原实现扫 client/test 与 src 两个已不存在的目录，扫描恒为空 → 测试闸门形同虚设；
//   测试实际由 vitest 收集 packages/*/tests/
// CONSTRAINT: 报告写 os.tmpdir()，避免污染仓库工作区
function runTests() {
  const isWin = process.platform === 'win32'
  const bin = path.join(ROOT, 'node_modules/.bin', isWin ? 'vitest.cmd' : 'vitest')
  if (!fs.existsSync(bin)) return { code: 1, out: '未找到 vitest' }
  const outFile = path.join(os.tmpdir(), `air-runner-vitest-${process.pid}.json`)
  try {
    const r = run(bin, ['run', '--config', 'vitest.config.ts', '--reporter=json', `--outputFile=${outFile}`], 600_000)
    const json = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : ''
    return { code: r.code, out: json || r.out }
  } finally {
    try { fs.unlinkSync(outFile) } catch { /* ignore */ }
  }
}

function runLint() {
  return run('npx', ['eslint', '.', '--format', 'json'], 180_000)
}

function countLintErrors(text) {
  try {
    const arr = JSON.parse(text)
    let n = 0
    for (const f of arr) { for (const m of f.messages || []) { if (m.severity === 2) n++
    }
    }
    return n
  } catch { return -1 }
}

function countTscErrors(text) {
  const m = text.match(/error TS\d+/g)
  return m ? m.length : 0
}

// 解析 vitest json reporter 的 numFailedTests；解析失败返回 -1（由调用方阻断，不静默放行）
function countTestFails(text) {
  try {
    const r = JSON.parse(text)
    return typeof r.numFailedTests === 'number' ? r.numFailedTests : -1
  } catch { return -1 }
}

const cmd = process.argv[2] || 'check'

if (cmd === 'init') {
  head('init baseline')
  console.log('  跑 pnpm typecheck...')
  const t = runTypecheck()
  console.log('  跑 vitest (json reporter)...')
  const u = runTests()
  console.log('  跑 eslint...')
  const l = runLint()
  const sha = run('git', ['rev-parse', 'HEAD']).out.trim().slice(0, 12)
  const baseline = {
    sha,
    ts: Date.now(),
    tsc: { code: t.code, errors: countTscErrors(t.out) },
    test: { code: u.code, fails: countTestFails(u.out) },
    lint: { code: l.code, errors: countLintErrors(l.out) },
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
  // [baseline-json-guard-v1] JSON 损坏时给出明确错误而非未捕获异常
  let base
  try {
    base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
  } catch (e) {
    err(`baseline 解析失败（${BASELINE}）: ${String(e)}`)
    err('删除该文件后跑 init 重建')
    process.exit(2)
  }
  console.log('  baseline sha:', base.sha, '@', new Date(base.ts).toISOString())
  console.log('  baseline tsc.errors:', base.tsc.errors, ' test.fails:', base.test.fails)
  // [baseline-staleness-hint-v1] 基线落后过久时差值闸门会长期假红（既有漂移被算成新增），
  //   失去分辨力。此处只提示不改退出码——重建基线属宿主侧决策。
  try {
    const ahead = Number(execFileSync('git', ['rev-list', '--count', `${base.sha}..HEAD`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim())
    if (Number.isFinite(ahead) && ahead > 50) console.log(`  ⚠ 基线已落后 ${ahead} 个提交，差值可能含既有漂移；建议宿主侧复核后重建`)
  } catch { /* swallow: 非 git 环境不影响闸门 */ }
  console.log('')
  console.log('  跑 pnpm typecheck...')
  const t = runTypecheck()
  const curTscErrors = countTscErrors(t.out)
  console.log('  跑 vitest (json reporter)...')
  const u = runTests()
  const curTestFails = countTestFails(u.out)
  // 报告缺失/不可解析时 curTestFails 为 -1；不静默放行，直接阻断
  if (curTestFails < 0) {
    err('✗ 无法解析 vitest json 报告，阻断')
    process.exit(1)
  }
  console.log('  跑 eslint...')
  const l = runLint()
  const curLintErrors = countLintErrors(l.out)
  console.log('')

  const dTsc = curTscErrors - base.tsc.errors
  const dTest = curTestFails - base.test.fails
  const baseLint = (base.lint && base.lint.errors) || 0
  const dLint = curLintErrors - baseLint

  const rows = [
    '  | 指标         | baseline | 当前 | 差值 |',
    '  |--------------|----------|------|------|',
    `  | tsc errors   | ${String(base.tsc.errors).padEnd(8)} | ${String(curTscErrors).padEnd(4)} | ${dTsc > 0 ? '+' : ''}${dTsc} |`,
    `  | test fails   | ${String(base.test.fails).padEnd(8)} | ${String(curTestFails).padEnd(4)} | ${dTest > 0 ? '+' : ''}${dTest} |`,
    `  | lint errors  | ${String(baseLint).padEnd(8)} | ${String(curLintErrors).padEnd(4)} | ${dLint > 0 ? '+' : ''}${dLint} |`,
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
  if (dLint > 0) {
    err(`✗ lint 新增 ${dLint} 个 error，阻断`)
    process.exit(1)
  }
  ok(`无新增回归（dTsc=${dTsc}, dTest=${dTest}, dLint=${dLint}）`)
  process.exit(0)
}

err('用法: node bin/check-regression.cjs [init|check]')
process.exit(2)
