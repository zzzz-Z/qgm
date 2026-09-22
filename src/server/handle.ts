// [refactor] HTTP 请求路由分发
import type { IncomingMessage, ServerResponse } from 'node:http'
import { buildLauncher } from './launcher.js'
import { PAGE } from './page.js'
import { sendHTML } from './http.js'
import { handleAskRoute, handleExecRoute, handleFilesRoutes, handleGitRoutes, handleHooksRoutes, handleRollbackRoutes, handleRunRoute, handleScriptRoutes, handleSkillsRoutes, handleTasks } from '../routes/index.js'

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost')
  const pathname = url.pathname
  // files/search/diff 路由（重构时丢失）
  if (await handleFilesRoutes(req, res, url)) return

  // hooks 路由（已抽至 routes/hooks.ts）
  if (await handleHooksRoutes(req, res, url)) return

  // skills 路由（已抽至 routes/skills.ts）
  if (await handleSkillsRoutes(req, res, url)) return

  // GET /tasks → 任务清单（读 .ai-runner/state.json）
  if (await handleTasks(req, res, url)) return

  // GET / → 页面壳
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return sendHTML(res, PAGE)
  }

  // GET /launcher.js → 注入到主页面的悬浮按钮脚本
  if (req.method === 'GET' && pathname === '/launcher.js') {
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(buildLauncher())
    return
  }

  // /exec 已抽至 routes/exec.ts
  if (await handleExecRoute(req, res, url)) return

  // /git/* 已抽至 routes/git.ts
  if (await handleGitRoutes(req, res, url)) return

  // /ask 已抽至 routes/ask.ts
  if (await handleAskRoute(req, res, url)) return
  // /run 已抽至 routes/run.ts
  if (await handleRunRoute(req, res, url)) return
  // /rollback* + /save 已抽至 routes/rollback.ts
  if (await handleRollbackRoutes(req, res, url)) return
  // /script/save 已抽至 routes/script.ts
  if (await handleScriptRoutes(req, res, url)) return

  res.writeHead(404)
  res.end('Not Found')
}
