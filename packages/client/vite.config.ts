// @desc web 端 vite 配置（SPA）。root=client 自身，含 UnoCSS + vue + aiRunner 注入插件。
// @why 前后端彻底分离：web SPA（5174）与后端 Hono 服务（5175）分进程运行。
//      dev 时通过 proxy 把 /__ai/* 转发到后端，前端代码无需改 URL。
//      package.json 是 type:module，本文件是 ESM，不能用 __dirname。
//      [AIRUNNER-PROXY-V1] /__ai 前缀转发到 AIR_BACKEND_URL（默认 http://127.0.0.1:5175）。
import { defineConfig } from 'vite'
import UnoCSS from 'unocss/vite'
import vue from '@vitejs/plugin-vue'
import { compression } from 'vite-plugin-compression2'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** client根目录 */
const CLIENT_ROOT = path.dirname(fileURLToPath(import.meta.url))
/** pkg根目录 */
const PKG_ROOT = path.dirname(CLIENT_ROOT)
/** BACKEND（相关状态/数据） */
const BACKEND = process.env.AIR_BACKEND_URL || 'http://127.0.0.1:5175'

/** [chunk-split-v1] 包名 → chunk 归组；顺序敏感（@vueuse 必须先于裸 vue 判定） */
const CHUNK_GROUPS: ReadonlyArray<readonly [string, RegExp]> = [
  ['vendor-vue', /^(?:vue|@vue\/|pinia|@vueuse\/)/],
  ['vendor-cm', /^(?:codemirror|@codemirror\/|@lezer\/|style-mod|w3c-keyname|crelt)/],
  ['vendor-hljs', /^highlight\.js\//],
  ['vendor-md', /^(?:markdown-it|entities|linkify-it|mdurl|uc\.micro|punycode\.js|diff|zod)(?:\/|$)/],
  ['vendor-fui', /^@floating-ui\//],
]

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
    // [precompress-v1] 产物旁生成 .gz/.br；serveStatic 按 Accept-Encoding 直接回源
    // [WHY] 省运行时压缩 CPU；2MB main 经 br 后约 250KB
    // [CONSTRAINT] threshold 512：rolldown-runtime（~0.7KB）在首屏 modulepreload 链上，
    //              原 1024 阈值会漏掉它；压缩后更大时插件自身会跳过
    compression({ algorithms: ['gzip', 'brotliCompress'], threshold: 512 }),
  ],
  // [chunk-split-v1] 拆分 2MB main：第三方库按域归组，便于 HTTP/2 并行与长缓存
  // [WHY] rolldown 1.2.x 的 manualChunks 只接受函数（对象形式报 "Expected Function"）
  // [CONSTRAINT] 必须匹配 .pnpm 真实路径：取最后一个 /node_modules/ 之后的段判包名
  // [CHANGE-IMPACT] vendor chunk 内容稳定 → hash 稳定，配合 serveStatic immutable 长缓存
  build: {
    rolldownOptions: {
      output: {
        manualChunks: (id: string) => {
          if (!id.includes('node_modules')) return undefined
          const tail = id.split('/node_modules/').pop() ?? ''
          for (const [name, re] of CHUNK_GROUPS) {
            if (re.test(tail)) return name
          }
          // [WHY] 不兜底合并：gpt-tokenizer（~2MB）由 tokenEstimator 动态 import，
          //       强行并入静态 vendor 会让惰性加载失效、2MB 重回首屏；返回 undefined 交给 rolldown 默认拆包
          return undefined
        },
      },
    },
  },
})
