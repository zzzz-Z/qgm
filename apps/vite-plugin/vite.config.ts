// @desc vite-plugin 打包：把 core bundle 进 dist/index.js，external 仅保留 vite 与 node:
// @why 发布态自包含，避免依赖 private 的 @qgm/core
import { defineConfig } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** HERE（相关状态/数据） */
const HERE = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: { extensions: ['.ts', '.tsx', '.mjs', '.js', '.json'] },
  build: {
    ssr: path.join(HERE, 'src', 'index.ts'),
    outDir: path.join(HERE, 'dist'),
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    sourcemap: false,
    // [rolldown-opt-v1] Vite 8 + rolldown 下 rollupOptions 是 deprecated 别名，与 client 侧统一
    rolldownOptions: {
      external: ['vite', /^node:/],
      output: { entryFileNames: 'index.js', format: 'esm' },
    },
  },
})
