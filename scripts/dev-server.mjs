#!/usr/bin/env node
// @desc server 端 dev 启动器：用 vite programmatic API 以 SSR 模式加载 apps/standalone/src/server.ts
// @why 双端各自 vite 启动。web 走 vite（packages/client/vite.config.ts），server 走本脚本（apps/standalone/vite.config.ts）。
//      无需预构建；改 src/server/** 立即生效（Vite 模块图 HMR 于 SSR 不适用，但每次重载走最新源码）。
//      生产仍走 `pnpm start`（bin/air-server.cjs → dist/_server/index.js）。

import { createServer } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)

console.log('[dev-server] 以 vite SSR 模式启动 apps/standalone/src/server.ts')

const server = await createServer({
  root: ROOT,
  configFile: path.join(ROOT, 'apps/standalone/vite.config.ts'),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'info',
})

// 通过 ssrLoadModule 加载入口：模块顶层会执行 ws-server.ts 内的 server.listen
await server.ssrLoadModule(path.join(ROOT, 'apps/standalone/src/server.ts'))

console.log('[dev-server] 已加载 ws-server.ts（监听端口由 AIR_SERVER_PORT 决定，默认 5175）')

// [dev-hmr-core-v1-devserver] core / standalone 源码变化 → 失效模块图并重新加载
const ENTRY = `${ROOT}/apps/standalone/src/server.ts`
server.watcher.on('change', async (file) => {
  if (!/packages[\\/]core[\\/]src|apps[\\/]standalone[\\/]src/.test(file)) return
  console.log('[dev-server] 热重载:', file)
  try {
    server.moduleGraph.invalidateAll()
    await server.ssrLoadModule(ENTRY)
    console.log('[dev-server] 已重载')
  } catch (e) {
    console.error('[dev-server] 重载失败:', e)
  }
})

// 保持进程存活；Ctrl+C 退出
process.on('SIGINT', async () => {
  console.log('[dev-server] 关闭中...')
  try { await server.close() } catch { /* ignore */ }
  process.exit(0)
})
process.on('SIGTERM', async () => {
  try { await server.close() } catch { /* ignore */ }
  process.exit(0)
})
