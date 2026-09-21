// @desc 统一 vite 配置（web/SPA）。仓库内唯一一份 vite 配置；server 端不经 vite。
// @why server 由 tsc + scripts/copy-runtime.cjs 构建，bin/air-server.cjs 调度，与 vite 无关。
//      package.json 为 type:module，因此本文件是 ESM，不能用 __dirname；改用 import.meta.url。
//      根目录即 PKG_ROOT；SPA 通过 root 指向 ./client。
import { defineConfig } from 'vite'
import UnoCSS from 'unocss/vite'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { aiRunner } from './src/index.js'

const PKG_ROOT = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_ROOT = path.resolve(PKG_ROOT, 'client')

export default defineConfig({
  root: CLIENT_ROOT,
  server: {
    port: 5174,
    fs: { allow: [PKG_ROOT] },
  },
  plugins: [
    UnoCSS({ configFile: path.resolve(CLIENT_ROOT, 'uno.config.ts') }),
    vue(),
    aiRunner({ root: PKG_ROOT }),
  ],
})
