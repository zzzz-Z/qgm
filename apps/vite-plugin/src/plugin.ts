/* eslint-disable no-console -- 服务端日志 */
// [workspace-core-v1] Vite 插件宿主专属逻辑；共享的 createRouter 抽自 router.ts。
// [client-main-v1] 加载时解析 client 入口注入 env；page.ts 依赖此 env 定位 Vue SPA 根。
import { createRequire } from 'node:module'
import { __pkgDir, attachWs, closeBrowser, createRouter, PREFIX, sendJSON, setRoot } from '@qgm/ai-runner-core'
import type { AiRunnerOptions } from '@qgm/ai-runner-core'
import type { Plugin, ViteDevServer } from 'vite'

/** __require（相关状态/数据） */
const __require = createRequire(import.meta.url)
if (!process.env.AI_RUNNER_CLIENT_MAIN) {
  try {
    process.env.AI_RUNNER_CLIENT_MAIN = __require.resolve('@qgm/ai-runner-client/main.ts')
  } catch {
    // 发布态或 client 包缺 main.ts：page.ts 走相对路径兜底（仓库内有效）
  }
}

export { createRouter } from '@qgm/ai-runner-core'
export type { Router } from '@qgm/ai-runner-core'

/**
 * 执行 ai Runner
 * @param options - options
 */
export function aiRunner(options: AiRunnerOptions = {}): Plugin {
  if (options.root) setRoot(options.root)
  const router = createRouter(options)
  return {
    name: 'vite-plugin-ai-runner',
    apply: 'serve',

    transformIndexHtml(html) {
      return {
        html,
        tags: [
          {
            tag: 'script',
            attrs: { type: 'module', src: `${PREFIX}/launcher.js` },
            injectTo: 'body',
          },
        ],
      }
    },

    configureServer(server: ViteDevServer) {
      // [U4] 忽略插件自身 src/ 变更，防 Vite 重启 dev server 打断循环
      // 副作用：改插件代码后需手动重启 dev server 让新逻辑生效
      try { server.watcher.unwatch(__pkgDir) } catch { }
      server.middlewares.use(PREFIX, (req, res) => {
        if (!req.url || req.url === '') req.url = '/'
        router.handle(req, res).catch((e: unknown) => {
          console.error('[ai-runner] 处理失败:', e)
          if (!res.headersSent) sendJSON(res, { error: String(e) }, 500)
        })
      })

      // 挂 WS 到 Vite httpServer，让 5174 也能跑无头链路
      if (server.httpServer) {
        const detach = attachWs(server.httpServer, { wsPath: `${PREFIX}/ws` })
        server.httpServer.on('close', () => { try { detach() } catch { /* ignore */ } })
        console.log(`  \x1B[32m➜\x1B[0m  \x1B[1mWS:\x1B[0m  \x1B[36mws://<host>${PREFIX}/ws\x1B[0m`)
      }

      server.httpServer?.on('close', () => { closeBrowser() })
      const origPrintUrls = server.printUrls.bind(server)
      server.printUrls = () => {
        origPrintUrls()
        const url = server.resolvedUrls?.local?.[0]
        if (url) {
          const base = url.endsWith('/') ? url.slice(0, -1) : url
          console.log(`  \x1B[32m➜\x1B[0m  \x1B[1mAI Runner:\x1B[0m  \x1B[36m${base}${PREFIX}/\x1B[0m`)
        }
      }
    },
  }
}
