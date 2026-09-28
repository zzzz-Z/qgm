import { build } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

function syncClientDist() {
  const src = path.join(ROOT, 'packages', 'client', 'dist')
  const dst = path.join(ROOT, 'apps', 'standalone', 'dist', 'client')
  if (!fs.existsSync(src)) { console.log('[build-all] skip (no client dist)'); return }
  // 清空旧目标
  if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true })
  fs.mkdirSync(dst, { recursive: true })
  copyDirSync(src, dst)
  console.log('[build-all] synced client dist -> apps/standalone/dist/client')
}

function copyDirSync(s, d) {
  for (const e of fs.readdirSync(s, { withFileTypes: true })) {
    const sp = path.join(s, e.name)
    const dp = path.join(d, e.name)
    if (e.isDirectory()) { fs.mkdirSync(dp, { recursive: true }); copyDirSync(sp, dp) }
    else { fs.copyFileSync(sp, dp)
    }
  }
}

console.log('[build-all] step 3/3: copy runtime .cjs')
const distRoot = path.join(ROOT, 'apps', 'standalone', 'dist')
fs.mkdirSync(distRoot, { recursive: true })
for (const f of ['interceptor.cjs', 'helpers.cjs', 'logger.cjs']) {
  const src = path.join(ROOT, 'packages', 'core', 'src', f)
  const dst = path.join(distRoot, f)
  if (fs.existsSync(src)) { fs.copyFileSync(src, dst); console.log(`[build-all] copied ${f}`) }
  else { console.log(`[build-all] skip (missing) ${f}`) }
}
console.log('[build-all] done')

// [AIRUNNER-BUILD-WATCH-V1] --watch 常驻：src/ 变更 → 自动重建 server + 拷贝 runtime
if (process.argv.includes('--watch')) {
  const { watch } = await import('node:fs')
  const srcDir = path.join(ROOT, 'packages', 'core', 'src')
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
  watch(srcDir, { recursive: true }, (_evt, _name) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(rebuild, 300)
  })
  console.log('[build-all:watch] 监听 packages/core/src 中，Ctrl+C 退出')
}
