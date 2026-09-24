// @desc server 端 vite 配置。仅 SSR：把 src/server/ws-server.ts 打成 apps/standalone/dist/_server/index.js。
// @why 双端解耦：web 侧配置在 packages/client/vite.config.ts，server 侧配置在本文件。
//      根 scripts/build-all.mjs 与 --watch 模式都引用本配置，避免三处重复维护。
//      dev 模式：pnpm dev:server 走 vite-node，直接跑 TS 源码（见 package.json）。
import { defineConfig } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** HERE（相关状态/数据） */
const HERE = path.dirname(fileURLToPath(import.meta.url))
/** 项目根目录 */
const ROOT = path.dirname(path.dirname(HERE))

export default defineConfig({
  root: ROOT,
  resolve: {
    extensions: ['.ts', '.tsx', '.mjs', '.js', '.json'],
    // [dev-hmr-core-v1-standalone] dev 态把 @qgm/ai-runner-core 指向源码，改 core 免 build 生效
    alias: {
      '@qgm/ai-runner-core': path.join(ROOT, 'packages', 'core', 'src', 'index.ts'),
    },
  },
  build: {
    ssr: path.join(ROOT, 'apps', 'standalone', 'src', 'server.ts'),
    outDir: path.join(ROOT, 'apps', 'standalone', 'dist', '_server'),
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: 'index.js',
        format: 'esm',
      },
    },
  },
})
