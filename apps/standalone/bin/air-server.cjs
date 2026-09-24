#!/usr/bin/env node
/* eslint-disable no-console -- CLI 日志输出 */
'use strict'
// [pkg-bin-v1] standalone 自包含 launcher
// - 仓库态：检测 core/apps 源码 mtime，必要时先 build
// - 发布态：直接跑包内 dist/_server/index.js
// 为什么用 CJS：package.json 是 type:module，但 bin 用 .cjs 后缀可稳跑
const path = require('node:path')
const fs = require('node:fs')
const { spawnSync, spawn } = require('node:child_process')

const HERE = __dirname
const PKG_ROOT = path.resolve(HERE, '..')
const REPO_ROOT = path.resolve(PKG_ROOT, '..', '..')
const DIST_ENTRY = path.join(PKG_ROOT, 'dist', '_server', 'index.js')

// logger 三级回退：包内 dist -> 仓库 dist -> core 源码
function pickLogger() {
  const candidates = [
    path.join(PKG_ROOT, 'dist', 'logger.cjs'),
    path.join(REPO_ROOT, 'dist', 'logger.cjs'),
    path.join(REPO_ROOT, 'packages', 'core', 'src', 'logger.cjs'),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) { try { return require(c) } catch { /* next */ } }
  }
  return { info: m => console.log(m), err: m => console.error(m) }
}
const L = pickLogger()

// 仓库态判定：core 源码存在即视为仓库态
const REPO_CORE_SRC = path.join(REPO_ROOT, 'packages', 'core', 'src')
const REPO_PLUGIN_SRC = path.join(REPO_ROOT, 'apps', 'vite-plugin', 'src')
// [srcIsNewer-v2] 加 client 源码根，且 .vue 也要算
const REPO_CLIENT_SRC = path.join(REPO_ROOT, 'packages', 'client', 'components')
const REPO_CLIENT_TS = path.join(REPO_ROOT, 'packages', 'client', 'composables')
const IS_REPO = fs.existsSync(REPO_CORE_SRC)

function srcIsNewer() {
  if (!IS_REPO) return false
  if (!fs.existsSync(DIST_ENTRY)) return true
  const distMtime = fs.statSync(DIST_ENTRY).mtimeMs
  const walk = (dir) => {
    let newest = 0
    if (!fs.existsSync(dir)) return newest
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        const s = walk(p)
        if (s > newest) newest = s
      } else if (e.isFile() && (p.endsWith('.ts') || p.endsWith('.cjs') || p.endsWith('.vue'))) {
        const m = fs.statSync(p).mtimeMs
        if (m > newest) newest = m
      }
    }
    return newest
  }
  const newest = Math.max(
    walk(REPO_CORE_SRC),
    walk(path.join(PKG_ROOT, 'src')),
    walk(REPO_PLUGIN_SRC),
    walk(REPO_CLIENT_SRC),
    walk(REPO_CLIENT_TS),
  )
  return newest > distMtime
}

if (srcIsNewer()) {
  L.info('检测到源码更新，先构建...')
  const r = spawnSync('pnpm', ['build'], { cwd: REPO_ROOT, stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) {
    L.err(`pnpm build 失败，退出码 ${r.status}`)
    process.exit(r.status || 1)
  }
}

if (!fs.existsSync(DIST_ENTRY)) {
  L.err(`未找到构建产物：${DIST_ENTRY}`)
  L.err('请在仓库内先跑 pnpm build，或使用发布版包')
  process.exit(1)
}

const child = spawn(process.execPath, [DIST_ENTRY], {
  cwd: IS_REPO ? REPO_ROOT : PKG_ROOT,
  stdio: 'inherit',
  env: process.env,
})

child.on('exit', (code, signal) => {
  process.exit(signal ? 128 : (code ?? 0))
})
