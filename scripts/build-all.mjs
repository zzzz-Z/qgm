import { build } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { syncClientDist } from './sync-client-dist.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)

console.log(`[build-all] ROOT=${ROOT}`)

console.log('[build-all] step 1/3: SPA (vite build, root=packages/client)')
await build({ configFile: path.join(ROOT, 'packages/client/vite.config.ts') })

console.log('[build-all] step 2/3: server (vite SSR, config=apps/standalone/vite.config.ts)')
await build({
  root: ROOT,
  configFile: path.join(ROOT, 'apps/standalone/vite.config.ts'),
  logLevel: 'info',
})

console.log('[build-all] step 2.5/3: sync SPA to apps/standalone/dist/client')
syncClientDist()

console.log('[build-all] step 3/3: copy runtime .cjs')
const distRoot = path.join(ROOT, 'apps', 'standalone', 'dist')
fs.mkdirSync(distRoot, { recursive: true })
// [repl-loop-dist-copy-v1] repl-loop.cjs 必须一并复制：
// session-manager.ts 用 new URL('../repl-loop.cjs', import.meta.url) 定位 REPL 子进程入口，
// bundle 落在 dist/_server/index.js ⇒ 解析为 dist/repl-loop.cjs。缺它 → 子进程 Cannot find module → REPL_EXITED。
// CHANGE-IMPACT: 删 repl-loop.cjs → /session 系列端点 create 成功但每帧 500 REPL_EXITED。
// [helpers-shell-v1] 与 copy-runtime.cjs 同一清单：helpers.cjs require 它，漏拷 → 轮内 exec/shell 全挂
for (const f of ['interceptor.cjs', 'helpers.cjs', 'logger.cjs', 'repl-loop.cjs']) {
  const src = path.join(ROOT, 'packages', 'core', 'src', f)
  const dst = path.join(distRoot, f)
  if (fs.existsSync(src)) { fs.copyFileSync(src, dst); console.log(`[build-all] copied ${f}`) }
  else { console.log(`[build-all] skip (missing) ${f}`) }
}
// [helpers-index-v1] helpers/ 子目录随包发布：index.cjs require ./io.cjs 等同级子文件
const helpersSrc = path.join(ROOT, 'packages', 'core', 'src', 'helpers')
const helpersDst = path.join(distRoot, 'helpers')
if (fs.existsSync(helpersSrc)) {
  fs.mkdirSync(helpersDst, { recursive: true })
  for (const f of fs.readdirSync(helpersSrc)) {
    if (!f.endsWith('.cjs')) continue
    fs.copyFileSync(path.join(helpersSrc, f), path.join(helpersDst, f))
    console.log(`[build-all] copied helpers/${f}`)
  }
}
// [preset-rules-move-v1] /__ai/preset/system 从 SSR 产物同级的 dist/SYSTEM.md 读取；缺则 404
// CHANGE-IMPACT: 删此段 → 发布态首问丢规则（只余工作区 AGENTS.md）
const sysSrc = path.join(ROOT, 'packages', 'core', 'SYSTEM.md')
const sysDst = path.join(distRoot, 'SYSTEM.md')
if (fs.existsSync(sysSrc)) { fs.copyFileSync(sysSrc, sysDst); console.log('[build-all] copied SYSTEM.md') }
else { console.log('[build-all] skip (missing) SYSTEM.md') }

// [build-all-inclusive-dist-v1] monorepo 根 build 一揽子刷新所有包的 dist：
//   - scripts/copy-runtime.cjs                → 根 dist/（npm 分发形态）
//   - packages/core/scripts/copy-runtime.cjs  → packages/core/dist/（@qgm/core 独立发布形态）
// WHY: 两份 copy-runtime 各自维护自己的 dist 目录；根 build 漏跑 → 发布态 SYSTEM.md 陈旧
// CHANGE-IMPACT: 删此段 → 根 dist/SYSTEM.md 与 packages/core/dist/SYSTEM.md 不随 build 更新
console.log('[build-all] step 4: refresh per-package dist (root + core)')
const { execFileSync } = await import('node:child_process')
for (const s of ['scripts/copy-runtime.cjs', 'packages/core/scripts/copy-runtime.cjs']) {
  try {
    execFileSync(process.execPath, [s], { cwd: ROOT, stdio: 'inherit' })
  } catch (e) {
    console.error(`[build-all] ${s} failed:`, e && e.message ? e.message : e)
  }
}
// [userscript-assemble-in-build-v1] 油猴脚本产物随 build 重建。
// [WHY] 源是 packages/core/src/tampermonkey/*.ts 的 22 个片段，产物是 scripts/tampermonkey-session-id.user.js；
//   此前只有手动跑 assemble-userscript.mjs 才会重建，改完片段忘重建 = 分发端点仍发旧脚本，且无任何报错。
// [CONSTRAINT] assemble 自身幂等（产物无变化则不写盘），故接进 build 不会污染 git status；
//   失败只告警不中断（产物是分发资产，不影响 server 启动）。
// [CONSTRAINT] @version 必须由人递增：脚本会打印提醒，但不会替人改版本号（改了会让语义失真）。
// CHANGE-IMPACT: 删此段 → 改片段后 build 不再重建产物，需手动跑 assemble。
console.log('[build-all] step 5: assemble userscript')
try {
  execFileSync(process.execPath, ['scripts/assemble-userscript.mjs'], { cwd: ROOT, stdio: 'inherit' })
} catch (e) {
  console.error('[build-all] assemble-userscript failed:', e && e.message ? e.message : e)
}
console.log('[build-all] done')

// [AIRUNNER-BUILD-WATCH-V1] --watch 常驻：src/ 变更 → 自动重建 server + 拷贝 runtime
if (process.argv.includes('--watch')) {
  const { watch } = await import('node:fs')
  // [watch-scope-v1] 服务端产物由 core 与 standalone 两侧源码共同驱动，
  // 只监听 core 会导致改 apps/standalone/src/server.ts 后不重建
  const watchDirs = [
    path.join(ROOT, 'packages', 'core', 'src'),
    path.join(ROOT, 'apps', 'standalone', 'src'),
  ]
  let rebuilding = false
  let pending = false
  const rebuild = async () => {
    if (rebuilding) { pending = true; return }
    rebuilding = true
    try {
      console.log('[build-all:watch] 检测到 src 变更，重建 server...')
      await build({
        root: ROOT,
        configFile: path.join(ROOT, 'apps/standalone/vite.config.ts'),
        logLevel: 'warn',
      })
      try {
        execFileSync(process.execPath, ['scripts/assemble-userscript.mjs'], { cwd: ROOT, stdio: 'inherit' })
      } catch { /* 产物重建失败不阻断 watch */ }
      console.log('[build-all:watch] ✓ 重建完成，请重启 air-server 使新 dist 生效')
    } catch (e) {
      console.error('[build-all:watch] ✗ 重建失败：', e && e.message ? e.message : e)
    } finally {
      rebuilding = false
      if (pending) { pending = false; setTimeout(rebuild, 200) }
    }
  }
  let timer = null
  const onChange = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(rebuild, 300)
  }
  for (const d of watchDirs) watch(d, { recursive: true }, onChange)
  console.log(`[build-all:watch] 监听 ${watchDirs.map(d => path.relative(ROOT, d)).join('、')} 中，Ctrl+C 退出`)
}
