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
const REPO_STANDALONE_SRC = path.join(PKG_ROOT, 'src')
// [srcIsNewer-v3] 客户端扫「整个 packages/client」而不是 components/composables 两个子目录：
// 旧实现漏掉 App.vue / main.ts / utils / directive / uno.config.ts / vite.config.ts / index.html，
// 改这些文件后 pnpm start 不会重建，会静默服务旧产物。
const REPO_CLIENT_SRC = path.join(REPO_ROOT, 'packages', 'client')
// [client-dist-marker-v1] 客户端产物的判据是 SPA 入口，不是 server 产物 DIST_ENTRY
const CLIENT_ENTRY = path.join(PKG_ROOT, 'dist', 'client', 'index.html')
const IS_REPO = fs.existsSync(REPO_CORE_SRC)

// 参与判定源码新旧的扩展名；产物与依赖不参与
// [src-ext-dts-v1] 排除 .d.ts（auto-imports.d.ts 等生成物）：生成物 mtime 会被构建/启动刷新，
//   纳入判定会让 air-server 每次启动都误判「源码更新」并触发构建
const SRC_EXT_RE = /(?<!\.d)\.(?:ts|tsx|vue|cjs|mjs|js|html|css)$/
// 遍历时要跳过的目录名
// [src-skip-dirs-v1] 追加 e2e/playwright-report/test-results/.ai-runner：测试产物 mtime 会被每次跑测试刷新
const SKIP_DIRS = new Set(['node_modules', 'dist', 'tests', 'e2e', 'playwright-report', 'test-results', '.ai-runner'])

/**
 * 遍历目录取最新 mtime
 * [CONSTRAINT] 必须跳过 dist/node_modules —— 产物自身在被写入后 mtime 最新，
 *              纳入判定会造成「构建完立刻又认为源码更新」的死循环重建
 * @param {string} dir 起始目录
 * @returns {number} 最新 mtime（无匹配文件返回 0）
 */
function walk(dir) {
  let newest = 0
  if (!fs.existsSync(dir)) return newest
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      const s = walk(p)
      if (s > newest) newest = s
    } else if (e.isFile() && SRC_EXT_RE.test(e.name)) {
      const m = fs.statSync(p).mtimeMs
      if (m > newest) newest = m
    }
  }
  return newest
}

/**
 * 判断产物是否落后于源码
 * [WHY] 客户端与服务端产物由不同源码驱动：SPA 只吃 packages/client，服务端产物只吃 core 与 apps。
 *       旧实现拿客户端源码 mtime 去比 server 产物，导致「只改客户端、服务端产物较新」时永不重建
 * [CONSTRAINT] 两侧分别比对各自的产物标记；任一落后即整体重建
 * [CHANGE-IMPACT] 返回 true 会触发整条 pnpm build（SPA + SSR），这是可接受的保守策略
 * @returns {boolean} true = 需要重建
 */
function srcIsNewer() {
  if (!IS_REPO) return false
  if (!fs.existsSync(DIST_ENTRY)) return true
  if (!fs.existsSync(CLIENT_ENTRY)) return true
  const serverNewest = Math.max(
    walk(REPO_CORE_SRC),
    walk(REPO_PLUGIN_SRC),
    walk(REPO_STANDALONE_SRC),
  )
  if (serverNewest > fs.statSync(DIST_ENTRY).mtimeMs) return true
  return walk(REPO_CLIENT_SRC) > fs.statSync(CLIENT_ENTRY).mtimeMs
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

// [signal-forward-v1] 把收到的终止信号转发给 server 子进程
// [WHY] 不转发则 kill launcher 后子进程变孤儿，继续占着端口，
//       下次启动被迫换端口（实测 5175 被占后落到 5176）
// [CONSTRAINT] 宽限 3s 后升级 SIGKILL，防止子进程卡死无法退出
function forwardSignal(signal) {
  if (child.exitCode !== null || child.signalCode !== null) process.exit(0)
  child.kill(signal)
  const t = setTimeout(() => child.kill('SIGKILL'), 3000)
  t.unref()
}
process.on('SIGTERM', () => forwardSignal('SIGTERM'))
process.on('SIGINT', () => forwardSignal('SIGINT'))

child.on('exit', (code, signal) => {
  process.exit(signal ? 128 : (code ?? 0))
})
