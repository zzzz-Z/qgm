// @desc web 端 vite 配置（SPA）。root=client 自身，含 UnoCSS + vue + aiRunner 注入插件。
// @why 前后端彻底分离：web SPA（5174）与后端 Hono 服务（5175）分进程运行。
//      dev 时通过 proxy 把 /__ai/* 转发到后端，前端代码无需改 URL。
//      package.json 是 type:module，本文件是 ESM，不能用 __dirname。
//      [AIRUNNER-PROXY-V1] /__ai 前缀转发到 AIR_BACKEND_URL（默认 http://127.0.0.1:5175）。
import { defineConfig } from 'vite'
import UnoCSS from 'unocss/vite'
import vue from '@vitejs/plugin-vue'
import { compression } from 'vite-plugin-compression2'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import AutoImport from 'unplugin-auto-import/vite'

/** client根目录 */
const CLIENT_ROOT = path.dirname(fileURLToPath(import.meta.url))
/** pkg根目录 */
const PKG_ROOT = path.dirname(CLIENT_ROOT)
/** BACKEND（相关状态/数据） */
// [port-drift-file-v1] 后端漂移端口落 .ai-runner/.server-port；env 显式优先，其次读文件，末选 5175
const REPO_ROOT = path.dirname(PKG_ROOT)
function resolveBackend(): string {
  if (process.env.AIR_BACKEND_URL) return process.env.AIR_BACKEND_URL
  try {
    const raw = fs.readFileSync(path.join(REPO_ROOT, '.ai-runner', '.server-port'), 'utf8').trim()
    if (/^\d+$/.test(raw)) return `http://127.0.0.1:${raw}`
  } catch { /* 文件缺失即用默认 */ }
  return 'http://127.0.0.1:5175'
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
      // [eventbus-name-clash-v1] 项目侧 useEventBus 与 @vueuse/core 同名，unimport 报
      //   "Duplicated imports ... is used" 并随机二选一。项目侧语义（模块级单例事件队列）
      //   与 @vueuse 的 EventBus 完全不同，选错即静默改变行为。此处显式 ignore 让
      //   auto-import 不再声明该名字，唯一源收敛到 useEventStream.ts；两个消费方已改为
      //   显式 import（tsc/vitest 无 auto-import 插件，本就必须显式）。
      ignore: ['useEventBus'],
      dirs: ['composables/**', 'utils/**'],
      // [dir-dedupe-v1] 排除与门面文件重名导出的实现文件，消除 unimport
      //   "Duplicated imports" 告警。排除判据（脚本双重核验）：
      //   ① 文件每个导出都能从其他扫描文件拿到（门面 re-export，同一绑定）；
      //   ② 或其独有符号在其他文件均被显式 import（不依赖 auto-import）。
      // [dir-dedupe-v4] 撤回 v2/v3 对 useAiWindow.ts 与 auto-loop/{state,persist,hooks,handoff}.ts
      //   的排除：全量 grep 事后证明其前提不成立。实测 openAiSession / openSite /
      //   copyAndFill / onNewSessionCreated / restore / runHook / handoffDisarm 等符号
      //   在 App.vue、useAiSite.ts、useAppStartup.ts、useAiReplyHandlers.ts、useAiTransport.ts、
      //   TerminalPane.vue、stop-and-finish.ts 等多处靠 auto-import 使用（无显式 import）。
      //   排除其定义文件会让符号在 dev 与 prod 运行时解析为 undefined；若 auto-imports.d.ts
      //   未同步重建，tsc 仍通过（声明残留）= 假绿，真实崩溃推迟到运行时。
      //   exec-flow.ts 的 [explicit-copyAndFill-v1] 记录的 copyAndFill 崩溃即此类。
      //   代价：Duplicated imports 告警回到 18+ 条，属同一绑定二选一的构建噪音，可接受。
      //   [约束] 未来再想排除，判据必须是逐符号全仓 grep + 逐个消费方核对 import 语句。
      dirsScanOptions: {
        // [loop-consolidation-P3e] 已删除 3 条指向 auto-loop/{types,timers,keyboard}.ts 的排除——
        //   该目录随 P3b 整目录删除，排除表不再引用不存在的路径。
        fileFilter: (file: string) =>
          !file.includes('composables/ui/event-stream.ts')
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
    // [chunk-size-limit-v1] 阈值提升至 600 kB：vendor-cm（codemirror 编辑器族）单 chunk
    //   505 kB 是各 @codemirror/* 包的固有合计，已由 compression 压至 br 141 kB；
    //   编辑器是 ScriptPanel 的核心交互面，位于首屏必经路径，强行懒加载会引入加载闪烁
    //   且各包互相依赖难以进一步拆分。这是有意取舍而非抑制告警：体积本身经 gzip/br 后可控。
    //   [CONSTRAINT] 若未来出现第二个超限 chunk，应重新评估是否引入动态 import。
    chunkSizeWarningLimit: 600,
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
