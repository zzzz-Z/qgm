#!/usr/bin/env node
/* eslint-disable no-console -- CLI 输出 */
'use strict'
const { spawnSync } = require('node:child_process')

const ROOT = process.cwd()
const BASE_URL = process.env.AI_RUNNER_BASE_URL || 'http://localhost:5174'
const L = require('./_logger-shim.cjs')

const c = L.c
const ok = s => console.log(c(32, '✓'), s)
const skip = s => console.log(c(33, '!'), s)
const err = s => console.error(c(31, '✗'), s)
const head = s => console.log(c(36, '▶'), s)

const results = []
function step(name, fn) {
  head(name)
  const t0 = Date.now()
  try {
    const code = fn()
    const ms = Date.now() - t0
    if (code === 0) { ok(`${name}  ${ms}ms`); results.push({ name, pass: true, ms }) }
    else { err(`${name}  exit ${code}  ${ms}ms`); results.push({ name, pass: false, ms }) }
    return code === 0
  } catch (e) {
    const ms = Date.now() - t0
    err(`${name}  抛错: ${String(e)}`)
    results.push({ name, pass: false, ms, error: String(e) })
    return false
  }
}
async function stepAsync(name, fn) {
  head(name)
  const t0 = Date.now()
  try {
    await fn()
    const ms = Date.now() - t0
    ok(`${name}  ${ms}ms`)
    results.push({ name, pass: true, ms })
    return true
  } catch (e) {
    const ms = Date.now() - t0
    err(`${name}  ${String(e)}`)
    results.push({ name, pass: false, ms, error: String(e) })
    return false
  }
}
function runPnpm(script) {
  const r = spawnSync('pnpm', ['run', script], { cwd: ROOT, stdio: 'inherit' })
  return r.status ?? -1
}
function serverUp() {
  return new Promise((resolve) => {
    const http = require('node:http')
    const req = http.get(`${BASE_URL}/__ai/`, (res) => { res.resume(); resolve(true) })
    req.on('error', () => resolve(false))
    req.setTimeout(1500, () => { req.destroy(); resolve(false) })
  })
}
// [discover-targets-v1] 主机侧冒烟也自动发现业务 app：探活常用 dev 端口（排除宿主 5175-5185）。
const COMMON_DEV_PORTS = [3000, 3001, 4000, 4200, 5000, 5173, 5174, 8000, 8080, 8081, 8090, 8091, 8888, 9000, 9001, 30000, 30001]
function probePort(port) {
  return new Promise((resolve) => {
    const net = require('node:net')
    const s = net.createConnection({ port, host: '127.0.0.1' }, () => { s.destroy(); resolve(true) })
    s.setTimeout(150)
    s.on('timeout', () => { s.destroy(); resolve(false) })
    s.on('error', () => { s.destroy(); resolve(false) })
  })
}
async function scanDevPorts() {
  const open = []
  for (let i = 0; i < COMMON_DEV_PORTS.length; i += 20) {
    const batch = COMMON_DEV_PORTS.slice(i, i + 20)
    const res = await Promise.all(batch.map(p => probePort(p)))
    batch.forEach((p, idx) => { if (res[idx]) open.push(p) })
  }
  return open.filter(p => p < 5175 || p > 5185)
}
async function smokeCheck() {
  const { chromium } = require('playwright')
  const browser = await chromium.launch({ headless: true })
  // 宿主自身（AI Runner）路径
  const targets = [{ tag: 'host', url: `${BASE_URL}/` }, { tag: 'host', url: `${BASE_URL}/__ai/` }]
  // 业务 app：自动发现的 dev 端口
  let appPorts = []
  try { appPorts = await scanDevPorts() } catch { /* 探测失败不阻断 */ }
  for (const port of appPorts) targets.push({ tag: `app:${port}`, url: `http://127.0.0.1:${port}/` })
  let fail = 0
  try {
    for (const t of targets) {
      const page = await browser.newPage()
      const errors = []
      page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))
      page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`) })
      page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`) })
      try { await page.goto(t.url, { waitUntil: 'networkidle', timeout: 30000 }) }
      catch (e) { errors.push(`导航失败: ${String(e)}`) }
      await page.close()
      const prefix = t.tag === 'host' ? '' : `[${t.tag}] `
      if (errors.length) { err(`${prefix}${t.url}: ${errors.join(' | ')}`); fail++ }
      else { console.log(`  ${c(32, '✓')} ${prefix}${t.url}`) }
    }
  } finally {
    try { await browser.close() } catch { /* swallow: close 失败不覆盖主流程结果 */ }
  }
  if (fail) throw new Error(`${fail} 个页面冒烟失败`)
}

;(async () => {
  head(`run-all  ${new Date().toISOString()}`)

  // [run-all-scope-v1] 标签必须与 package.json 中实际脚本一致：
  // 原先标签写 `eslint --fix` / `vue-tsc -b --force` / `node --test`，实际跑的是 lint / tsc / vitest
  step('lint (eslint .)', () => runPnpm('lint'))
  // [typecheck-single-entry] 类型检查收敛为单入口
  // WHY: 各处自拼 tsc/vue-tsc 组合时容易漏 -p 或走错 tsconfig（如 vue-tsc 配 core 配置），
  //   导致前端类型错误不被拦截；统一走 package.json 的 typecheck
  // CHANGE-IMPACT: 覆盖面由「core + apps + client」扩为「+ test/」，首次可能暴露存量 test 类型错误
  step('typecheck (tsc + tsc:apps + tsc:client + test:tsc)', () => runPnpm('typecheck'))
  step('test:unit (vitest run)', () => runPnpm('test:unit'))

  const up = await serverUp()
  if (!up) {
    skip(`test:e2e  跳过（${BASE_URL} 未启动）`)
    skip(`smoke    跳过（${BASE_URL} 未启动）`)
    results.push({ name: 'test:e2e', pass: true, ms: 0, skipped: true })
    results.push({ name: 'smoke', pass: true, ms: 0, skipped: true })
  } else {
    step('test:e2e (playwright)', () => runPnpm('test:e2e'))
    await stepAsync('smoke (/ 和 /__ai/)', smokeCheck)
  }

  head('汇总')
  const failed = results.filter(r => !r.pass)
  const passed = results.filter(r => r.pass && !r.skipped)
  const skipped = results.filter(r => r.skipped)
  for (const r of results) {
    const tag = r.skipped ? c(33, '!') : (r.pass ? c(32, '✓') : c(31, '✗'))
    console.log(`  ${tag} ${r.name.padEnd(28)} ${r.skipped ? '跳过' : `${r.ms}ms`}`)
  }
  console.log('')
  if (failed.length) { err(`${failed.length} 步失败 / ${passed.length} 步通过 / ${skipped.length} 步跳过`); process.exit(1) }
  ok(`全部通过（${passed.length} 步，${skipped.length} 跳过）`)
})().catch((e) => { err(String((e && e.stack) || e)); process.exit(1) })
