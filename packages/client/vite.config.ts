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
    // [auto-import-v1] 免 import 使用 vue/@vueuse/core 与本地 composables/utils
    // [WHY] 大量组件重复 import ref/computed/useXxx；集中声明减少样板
    // [CONSTRAINT] dts 输出路径须与 tsconfig.client include 匹配（packages/client/**/*.d.ts）
    // [CONSTRAINT] unplugin-auto-import 的 '@vueuse/core' 预设走 local-pkg.resolveModule，
    //   解析基准是 process.cwd()（`pnpm build` / `dev:web` 下 = 仓库根），而不是 vite root 或本文件位置。
    //   故根 package.json 必须显式声明 devDependency '@vueuse/core'——删掉它 cwd 处解析不到包，
    //   插件报 "[auto-import] failed to load @vueuse/core" 并中断构建。
    //   （@vueuse/core v15 已移除 indexes.json，预设实际回落到 @vueuse/metadata/index.json）
    AutoImport({
      imports: ['vue', '@vueuse/core'],
      dirs: ['composables/**', 'utils/**'],
      // [dir-dedupe-v1] 排除与门面文件重名导出的实现文件，消除 unimport
      //   "Duplicated imports" 告警。排除判据（脚本双重核验）：
      //   ① 文件每个导出都能从其他扫描文件拿到（门面 re-export，同一绑定）；
      //   ② 或其独有符号在其他文件均被显式 import（不依赖 auto-import）。
      //   两判据都不满足的文件（state/hooks/persist/handoff/useAiWindow）不能排除，
      //   其残余同名告警是门面架构的已知噪音（二选一结果同绑定），非错误。
      dirsScanOptions: {
        fileFilter: (file: string) =>
          !file.includes('composables/ai/auto-loop/types.ts')
          && !file.includes('composables/ai/auto-loop/timers.ts')
          && !file.includes('composables/ai/auto-loop/keyboard.ts')
          && !file.includes('composables/ui/event-stream.ts')
          && !file.includes('utils/context-error-locations.ts')
          && !file.includes('utils/codeCleaner.ts'),
      },
      dts: 'auto-imports.d.ts',
      vueTemplate: true,
    }),
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
          // [WHY] 不兜底合并：gpt-tokenizer（~2MB）由预估模块动态 import，
          //       强行并入静态 vendor 会让惰性加载失效、2MB 重回首屏；返回 undefined 交给 rolldown 默认拆包
          return undefined
        },
      },
    },
  },
})
