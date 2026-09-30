// @desc web 端 vite 配置（SPA）。root=client 自身，含 UnoCSS + vue + aiRunner 注入插件。
// @why 前后端彻底分离：web SPA（5174）与后端 Hono 服务（5175）分进程运行。
//      dev 时通过 proxy 把 /__ai/* 转发到后端，前端代码无需改 URL。
//      package.json 是 type:module，本文件是 ESM，不能用 __dirname。
//      [AIRUNNER-PROXY-V1] /__ai 前缀转发到 AIR_BACKEND_URL（默认 http://127.0.0.1:5175）。
import { defineConfig } from 'vite'
import UnoCSS from 'unocss/vite'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** client根目录 */
const CLIENT_ROOT = path.dirname(fileURLToPath(import.meta.url))
/** pkg根目录 */
const PKG_ROOT = path.dirname(CLIENT_ROOT)
/** BACKEND（相关状态/数据） */
const BACKEND = process.env.AIR_BACKEND_URL || 'http://127.0.0.1:5175'

export default defineConfig({
  root: CLIENT_ROOT,
  // [dev-hmr-core-v1-client] 让 client 侧插件加载 core 源码，改 core 免 build 生效
  resolve: {
    alias: {
      '@qgm/core': path.join(PKG_ROOT, 'core', 'src', 'index.ts'),
      '@': path.join(PKG_ROOT, 'client')
    },
  },
  server: {
    port: 5174,
    fs: { allow: [PKG_ROOT] },
    watch: {
      ignored: [
        '**/.ai-runner/**',
        '**/dist/**',
        '**/client/dist/**',
        '**/.git/**',
      ],
    },
    // [AIRUNNER-PROXY-V1] 前后端分离：/__ai/* 走独立后端进程
    proxy: {
      '/__ai': {
        target: BACKEND,
        changeOrigin: true,
        ws: true, // 让 /__ai/ws WebSocket 也走 proxy
        // [csrf-proxy-fix-v1] changeOrigin 只改写 Host，浏览器 Origin(5174) 仍透传；
        // 后端 guardRequest 要求 Origin.host === Host，故显式对齐避免 POST 403
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('origin', BACKEND)
          })
        },
      },
    },
  },
  plugins: [
    UnoCSS({ configFile: path.resolve(CLIENT_ROOT, 'uno.config.ts') }),
    vue(),
  ],
})
