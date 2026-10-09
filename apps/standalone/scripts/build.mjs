#!/usr/bin/env node
/* eslint-disable no-console -- CLI 日志输出 */
// @desc: standalone 包内自包含 build 编排：vite SSR + copy runtime + sync client dist
// @why: 发布链路——产出 dist/_server/index.js + dist/client/* + dist/*.cjs
import { build } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { syncClientDist } from '../../../scripts/sync-client-dist.mjs'

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
// [helpers-index-v1] helpers/ 子目录随包发布：index.cjs require ./io.cjs 等同级子文件，
//   [CONSTRAINT] 保持目录层级不变；漏拷子目录 = 运行时 MODULE_NOT_FOUND
const helpersSrc = path.join(runtimeDir, 'helpers')
const helpersDst = path.join(DIST_ROOT, 'helpers')
if (fs.existsSync(helpersSrc)) {
  fs.mkdirSync(helpersDst, { recursive: true })
  for (const f of fs.readdirSync(helpersSrc)) {
    if (!f.endsWith('.cjs')) continue
    fs.copyFileSync(path.join(helpersSrc, f), path.join(helpersDst, f))
    console.log(`  copied helpers/${f}`)
  }
}

// [preset-rules-move-v1] /__ai/preset/system 从 dist/SYSTEM.md 读取；缺则 404
//   WHY: preset.ts 用 import.meta.url 回溯 SYSTEM.md，发布产物需显式复制
//   CHANGE-IMPACT: 删此段 → 发布态规则加载静默失败（只余 AGENTS.md）
const rulesSrc = path.join(ROOT, 'packages', 'core', 'SYSTEM.md')
const rulesDst = path.join(DIST_ROOT, 'SYSTEM.md')
if (fs.existsSync(rulesSrc)) {
  fs.copyFileSync(rulesSrc, rulesDst)
  console.log('  copied SYSTEM.md')
} else {
  console.log('  skip (missing) SYSTEM.md')
}
console.log('[standalone:build] step 3/3: sync client dist')
// [sync-dedup-v1] 复用 scripts/sync-client-dist.mjs，避免与 build-all.mjs / build:web 三处各写一份拷贝逻辑
syncClientDist(path.join(ROOT, 'packages', 'client', 'dist'), path.join(DIST_ROOT, 'client'))

console.log('[standalone:build] done')
