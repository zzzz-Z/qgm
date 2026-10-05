// [refactor] HTTP 请求分发：业务路由全量走 Hono（见 src/routes/hono/）
import type { IncomingMessage, ServerResponse } from 'node:http'
import { buildLauncher } from './launcher.js'
import { buildPage } from './page.js'
import { sendHTML } from './http.js'
import { honoApp } from './hono-app.js'
import { getHasWorkspace } from '../config.js'
import { HONO_PREFIXES } from '../routes/index.js'
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
// [userscript-update-v1] /userscript 进豁免：油猴脚本属于「建立连接的前置条件」，
//   与用户是否选过工作区无关——引导页阶段同样要能装/更新脚本。
/** 无工作区时仍放行的业务前缀：选择入口自身、预置规则、油猴脚本分发（均不依赖工作区） */
const WORKSPACE_EXEMPT_PREFIXES = ['/workspace', '/preset', '/userscript']

/**
 * 判定当前请求是否需要工作区
 * [WHY] 生产环境默认无工作区；所有工作区相关业务端点须在入口拒绝，避免下游 getRoot() 用旧 cwd 误操作
 * [CONSTRAINT] 只对 HONO_PREFIXES 内的业务前缀生效；静态资源 / 页面 / launcher 不在其列，直接放行
 * [CHANGE-IMPACT] 新增业务前缀时自动纳入守卫；白名单变更须与 /workspace/clear 端点语义保持一致
 * @param pathname 请求路径（已剥离 /__ai 前缀）
 */
function requireWorkspace(pathname: string): boolean {
  if (getHasWorkspace()) return true
  const isHonoPath = HONO_PREFIXES.some(p => pathname === p || pathname.startsWith(`${p}/`))
  if (!isHonoPath) return true
  return WORKSPACE_EXEMPT_PREFIXES.some(p => pathname === p || pathname.startsWith(`${p}/`))
}

async function dispatchHono(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  // [workspace-mode-v1] 无工作区守卫：拦截工作区相关端点，仅放行入口/预置
  if (!requireWorkspace(url.pathname)) {
    res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'NO_WORKSPACE', hint: '请先选择工作区（POST /__ai/workspace/select 或 /__ai/workspace/pick）' }))
    return true
  }
  // [arch-hono-dispatch-v2]
  // 不再依赖白名单：任何请求先试 Hono；404 时回退到静态/页面/404。
  const origin = inferOrigin(req)
  const fetchReq = await nodeToFetchRequest(req, origin)
  const resp = await honoApp.fetch(fetchReq)
  // [hono-404-bridge-v2] Hono 无路由时默认回 text/plain 404；业务路由 404 均为 c.json。
  // 仅纯文本 404 视为「未命中」回退静态/页面；JSON 404 是合法业务响应，直接透传，
  // 否则「基准记录不存在」等错误体会被兜底 res.end('Not Found') 吞掉
  if (resp.status === 404 && !(resp.headers.get('content-type') || '').includes('application/json')) return false
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
  // [url-parse-guard-v3] req.url 是**任意字节串**，不一定能被 URL 解析：
  //   `GET // HTTP/1.1` ⇒ new URL('//', 'http://localhost') 抛 ERR_INVALID_URL。
  // [WHY] 本函数是所有业务的唯一分发入口（业务 → 首页 → launcher → 404），抛出后只会落到
  //   调用方的 `.catch`（apps/standalone/src/server.ts、apps/vite-plugin/src/plugin.ts）
  //   被统一记成 **500** —— 而「请求目标畸形」是**客户端过错**，正确语义是 400。
  //   实测：修完 serveStatic 之后，`GET //` 的响应从「挂到超时」变成 500 Internal Server Error。
  // [CONSTRAINT] 必须在这里判掉：下钻的 nodeToFetchRequest（hono-bridge）会**再次**解析同一个
  //   req.url，此处放行即等于把它一起覆盖；hono-bridge 的调用方只有本函数这一处。
  // [CHANGE-IMPACT] 畸形目标由「500 + 堆栈噪音」变为「400 Bad Request」；422/415 等既有语义不变。
  //   由 url-parse-guard.node-test.ts 守卫。
  let url: URL
  try {
    url = new URL(req.url || '/', 'http://localhost')
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Bad Request')
    return
  }
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
