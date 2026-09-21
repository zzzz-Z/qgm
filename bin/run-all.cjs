#!/usr/bin/env node
/* eslint-disable no-console -- CLI 输出 */
'use strict'
const { spawnSync } = require('node:child_process')

const ROOT = process.cwd()
const BASE_URL = process.env.AI_RUNNER_BASE_URL || 'http://localhost:5174'
const L = require('../src/logger.cjs')

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
async function smokeCheck() {
  const { chromium } = require('playwright')
  const browser = await chromium.launch({ headless: true })
  const paths = ['/', '/__ai/']
  let fail = 0
  try {
    for (const p of paths) {
      const page = await browser.newPage()
      const errors = []
      page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))
      page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`) })
      page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`) })
      try { await page.goto(BASE_URL + p, { waitUntil: 'networkidle', timeout: 30000 }) }
      catch (e) { errors.push(`导航失败: ${String(e)}`) }
      await page.close()
      if (errors.length) { err(`${p}: ${errors.join(' | ')}`); fail++ }
      else { console.log(`  ${c(32, '✓')} ${p}`)
      }
    }
  } finally {
    try { await browser.close() } catch {}
  }
  if (fail) throw new Error(`${fail} 个页面冒烟失败`)
}

;(async () => {
  head(`run-all  ${new Date().toISOString()}`)

  step('lint (eslint --fix)', () => runPnpm('lint'))
  step('tsc (vue-tsc -b --force)', () => runPnpm('tsc'))
  step('test:unit (node --test)', () => runPnpm('test:unit'))

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
