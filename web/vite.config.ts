// web/vite.config.ts —— 自托管：跑 web dev 时挂自家插件（root=包根）
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'
import { aiRunner } from '../src/index.js'

const PKG_ROOT = path.resolve(__dirname, '..')

export default defineConfig({
  root: path.resolve(__dirname),
  server: {
    port: 5174,
    fs: { allow: [PKG_ROOT] },
  },
  plugins: [
    vue(),
    aiRunner({ root: PKG_ROOT }),
  ],
})
