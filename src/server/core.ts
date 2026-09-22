/* eslint-disable no-console -- 服务端日志 */
import type { Plugin, ViteDevServer } from 'vite'
import { PREFIX, setRoot } from '../config.js'
import { closeBrowser } from '../headless/smoke.js'
import { __pkgDir } from './page.js'
import { handle } from './handle.js'
import { attachWs } from './attach-ws.js' // [fix-vite-ws]
import { guardRequest, sendJSON } from './http.js'
import type { AiRunnerOptions, IncomingMessage, ServerResponse } from './http.js'

// ============================================================================
// 插件导出
// ============================================================================

export interface Router {
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>
}

export function createRouter(options: AiRunnerOptions = {}): Router {
  return {
    handle(req, res) {
      if (!guardRequest(req, res, options)) return Promise.resolve()
      return handle(req, res)
    },
  }
}

export function aiRunner(options: AiRunnerOptions = {}): Plugin {
  if (options.root) setRoot(options.root)
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
        if (!guardRequest(req, res, options)) return

        Promise.resolve(handle(req, res)).catch((e: unknown) => {
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
