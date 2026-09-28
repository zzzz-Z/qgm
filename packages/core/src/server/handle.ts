// [refactor] HTTP 请求分发：业务路由全量走 Hono（见 src/routes/hono/）
import type { IncomingMessage, ServerResponse } from 'node:http'
import { buildLauncher } from './launcher.js'
import { buildPage } from './page.js'
import { sendHTML } from './http.js'
import { honoApp } from './hono-app.js'
import { fetchResponseToNode, inferOrigin, nodeToFetchRequest } from './hono-bridge.js'

// [arch-hono] 业务请求全量走 Hono；404 时回退页面壳 / 静态资源 / 404

/**
 * 把请求转交 Hono 应用处理；命中则写回响应
 * [WHY] 不依赖白名单 —— 任何请求先试 Hono，404 时返回 false 让上层回退静态/页面/404
 * [CONSTRAINT] 返回 true 表示已处理并写回响应，调用方不得再写；返回 false 表示未命中，需上层兜底
 * [CHANGE-IMPACT] 语义变更会影响 handle 的回退顺序；honoApp 抛出异常时本函数不吞错
 * @param req Node 请求对象
 * @param res Node 响应对象（仅在命中时写入）
 * @param url 已解析的 URL；用于补全 origin 与透传 pathname
 */
async function dispatchHono(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  // [arch-hono-dispatch-v2]
  // 不再依赖白名单：任何请求先试 Hono；404 时回退到静态/页面/404。
  const origin = inferOrigin(req)
  const fetchReq = await nodeToFetchRequest(req, origin)
  const resp = await honoApp.fetch(fetchReq)
  if (resp.status === 404) return false
  await fetchResponseToNode(res, resp)
  return true
}

/**
 * HTTP 请求分发入口（业务 → 首页 → launcher → 404）
 * [WHY] 回退链顺序有语义：Hono 404 时再试页面 / 静态资源；最后才 404 兜底
 * [CONSTRAINT] 只处理 GET 的首页与 launcher.js；其他方法一旦 Hono 未命中即 404
 * [CHANGE-IMPACT] 新增静态资源路由须插在 launcher.js 分支前，否则会被 404 吞掉
 * @param req Node 请求对象
 * @param res Node 响应对象
 */
export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost')
  const pathname = url.pathname

  if (await dispatchHono(req, res, url)) return

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return sendHTML(res, buildPage())
  }

  if (req.method === 'GET' && pathname === '/launcher.js') {
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(buildLauncher())
    return
  }

  res.writeHead(404)
  res.end('Not Found')
}
