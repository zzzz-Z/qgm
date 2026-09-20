import { defineConfig } from 'vite'
import UnoCSS from 'unocss/vite'
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
    UnoCSS({ configFile: path.resolve(__dirname, 'uno.config.ts') }),
    vue(),
    aiRunner({ root: PKG_ROOT }),
  ],
})
