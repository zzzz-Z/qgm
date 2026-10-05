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
for (const f of ['interceptor.cjs', 'helpers.cjs', 'logger.cjs', 'repl-loop.cjs']) {
  const src = path.join(ROOT, 'packages', 'core', 'src', f)
  const dst = path.join(distRoot, f)
  if (fs.existsSync(src)) { fs.copyFileSync(src, dst); console.log(`[build-all] copied ${f}`) }
  else { console.log(`[build-all] skip (missing) ${f}`) }
}
// [preset-rules-move-v1] /__ai/preset/system 从 SSR 产物同级的 dist/SYSTEM.md 读取；缺则 404
// CHANGE-IMPACT: 删此段 → 发布态首问丢规则（只余工作区 AGENTS.md）
const sysSrc = path.join(ROOT, 'packages', 'core', 'SYSTEM.md')
const sysDst = path.join(distRoot, 'SYSTEM.md')
if (fs.existsSync(sysSrc)) { fs.copyFileSync(sysSrc, sysDst); console.log('[build-all] copied SYSTEM.md') }
else { console.log('[build-all] skip (missing) SYSTEM.md') }
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
