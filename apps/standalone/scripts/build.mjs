#!/usr/bin/env node
/* eslint-disable no-console -- CLI 日志输出 */
// @desc: standalone 包内自包含 build 编排：vite SSR + copy runtime + sync client dist
// @why: 发布链路——产出 dist/_server/index.js + dist/client/* + dist/*.cjs
import { build } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.dirname(HERE) // apps/standalone
const ROOT = path.dirname(path.dirname(PKG_ROOT)) // 仓库根
const DIST_ROOT = path.join(PKG_ROOT, 'dist')

console.log('[standalone:build] step 1/3: vite SSR')
await build({
  configFile: path.join(PKG_ROOT, 'vite.config.ts'),
  logLevel: 'info',
})

console.log('[standalone:build] step 2/3: copy runtime .cjs')
const runtimeDir = path.join(ROOT, 'packages', 'core', 'src')
for (const f of ['interceptor.cjs', 'helpers.cjs', 'logger.cjs']) {
  const src = path.join(runtimeDir, f)
  const dst = path.join(DIST_ROOT, f)
  if (fs.existsSync(src)) { fs.copyFileSync(src, dst); console.log(`  copied ${f}`) }
  else { console.log(`  skip (missing) ${f}`) }
}

// [preset-rules-fix] /__ai/preset/system 从 dist/rules/SYSTEM.md 读取；缺则 404
//   WHY: preset.ts 用 import.meta.url 回溯 rules/SYSTEM.md，发布产物需显式复制
//   CHANGE-IMPACT: 删此段 → 发布态规则加载静默失败（只余 AGENTS.md）
const rulesSrc = path.join(ROOT, 'packages', 'core', 'src', 'rules', 'SYSTEM.md')
const rulesDstDir = path.join(DIST_ROOT, 'rules')
if (fs.existsSync(rulesSrc)) {
  fs.mkdirSync(rulesDstDir, { recursive: true })
  fs.copyFileSync(rulesSrc, path.join(rulesDstDir, 'SYSTEM.md'))
  console.log('  copied rules/SYSTEM.md')
} else {
  console.log('  skip (missing) rules/SYSTEM.md')
}
console.log('[standalone:build] step 3/3: sync client dist')
const srcClient = path.join(ROOT, 'packages', 'client', 'dist')
const dstClient = path.join(DIST_ROOT, 'client')
if (fs.existsSync(srcClient)) {
  if (fs.existsSync(dstClient)) fs.rmSync(dstClient, { recursive: true, force: true })
  copyDir(srcClient, dstClient)
  console.log('  synced packages/client/dist -> apps/standalone/dist/client')
} else {
  console.log('  skip (no client dist, run packages/client build first)')
}

function copyDir(s, d) {
  fs.mkdirSync(d, { recursive: true })
  for (const e of fs.readdirSync(s, { withFileTypes: true })) {
    const sp = path.join(s, e.name)
    const dp = path.join(d, e.name)
    if (e.isDirectory()) copyDir(sp, dp)
    else fs.copyFileSync(sp, dp)
  }
}

console.log('[standalone:build] done')
