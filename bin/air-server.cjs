#!/usr/bin/env node
'use strict'
// air-server 独立壳：构建到 dist 后运行 dist/ws-server.js。
// 为什么不用 --experimental-strip-types：Node 的 TS strip 不重写 .js → .ts 路径，
// 运行时 import './config.js' 会 ERR_MODULE_NOT_FOUND。
const { spawnSync, spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const L = require('../src/logger.cjs')

const ROOT = process.cwd()
const DIST_ENTRY = path.join(ROOT, 'dist', 'server', 'ws-server.js')
const SRC_ENTRY = path.join(ROOT, 'src', 'server', 'ws-server.ts')

if (!fs.existsSync(SRC_ENTRY)) {
  L.err(`未找到 src/ws-server.ts（cwd=${ROOT}）`)
  process.exit(1)
}

function srcIsNewer() {
  if (!fs.existsSync(DIST_ENTRY)) return true
  try {
    const distMtime = fs.statSync(DIST_ENTRY).mtimeMs
    const walk = (dir) => {
      let newest = 0
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name)
        if (ent.isDirectory()) {
          const sub = walk(p)
          if (sub > newest) newest = sub
        } else if (ent.isFile() && (p.endsWith('.ts') || p.endsWith('.cjs'))) {
          const m = fs.statSync(p).mtimeMs
          if (m > newest) newest = m
        }
      }
      return newest
    }
    return walk(path.join(ROOT, 'src')) > distMtime
  } catch { return true }
}

if (srcIsNewer()) {
  L.info('检测到 src 更新，先构建...')
  const r = spawnSync('pnpm', ['build'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) {
    L.err(`pnpm build 失败，退出码 ${r.status}`)
    process.exit(r.status || 1)
  }
}

if (!fs.existsSync(DIST_ENTRY)) {
  L.err(`构建后仍未找到 ${DIST_ENTRY}`)
  process.exit(1)
}

const child = spawn(process.execPath, [DIST_ENTRY], {
  cwd: ROOT,
  stdio: 'inherit',
  env: process.env,
})

child.on('exit', (code, signal) => {
  if (signal) { process.exit(128) }
  process.exit(code ?? 0)
})
