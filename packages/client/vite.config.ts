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
import AutoImport from 'unplugin-auto-import/vite'

/** client根目录 */
const CLIENT_ROOT = path.dirname(fileURLToPath(import.meta.url))
/** pkg根目录 */
const PKG_ROOT = path.dirname(CLIENT_ROOT)
/** BACKEND（相关状态/数据） */
// [port-contract-v1] 端口为契约：dev 后端恒 5275（dev-all 会传 AIR_BACKEND_URL 覆盖）
function resolveBackend(): string {
  return process.env.AIR_BACKEND_URL || 'http://127.0.0.1:5275'
}
const BACKEND = resolveBackend()

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
    // [cm-dedupe-v1] CodeMirror 6 要求 @codemirror/state 单实例：Extension 身份靠
    //   @codemirror/state 模块导出的 Symbol 判定（Extension.isExtension），若打包器
    //   产出两份 state 实例，则「另一份」创建的 Extension 会被判为普通对象，
    //   EditorState.create 抛 "Unrecognized extension value in extension set ([object Object])"。
    //   pnpm 侧只有一份物理路径（实测 .pnpm/@codemirror+state@6.7.6），问题出在
    //   rolldown 的 chunk 切分把它同时编进 vendor-cm 与消费方；dedupe 强制解析到同一份。
    //   [CONSTRAINT] @codemirror/view、@codemirror/commands、@codemirror/language
    //   都从 state 拉 Extension 标识，必须一并去重，只 dedupe state 不够。
    dedupe: [
      '@codemirror/state',
      '@codemirror/view',
      '@codemirror/commands',
      '@codemirror/language',
    ],
  },
  server: {
    port: 5274,
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
    AutoImport({
      imports: ['vue', '@vueuse/core'],
      ignore: ['useEventBus'],
      dirs: ['composables/**', 'utils/**'],
      dirsScanOptions: {
        fileFilter: (file: string) =>
          !file.includes('composables/ui/event-stream.ts')
          && !file.includes('utils/context-error-locations.ts')
          && !file.includes('utils/codeCleaner.ts'),
      },
      dts: 'auto-imports.d.ts',
      vueTemplate: true,
    }),
    compression({ algorithms: ['gzip', 'brotliCompress'], threshold: 512 }),
  ],
  build: {
    chunkSizeWarningLimit: 600,
    rolldownOptions: {
      output: {
        manualChunks: (id: string) => {
          if (!id.includes('node_modules')) return undefined
          const tail = id.split('/node_modules/').pop() ?? ''
          for (const [name, re] of CHUNK_GROUPS) {
            if (re.test(tail)) return name
          }
          return undefined
        },
      },
    },
  },
})
