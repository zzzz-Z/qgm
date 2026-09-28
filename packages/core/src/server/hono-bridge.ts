// [arch-hono] HTTP 层桥接：Node IncomingMessage/ServerResponse ↔ fetch Request/Response
// 目标：路由实现只依赖 fetch 语义，Node 差异在此处吸收
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * 把 Node 的 IncomingMessage 转换为标准 fetch Request
 * [WHY] 让路由层只依赖 fetch 语义，Node 差异集中在此处吸收（Hono 迁移需要）
 * [CONSTRAINT] body 用 buffer 读齐而非 stream —— 避免 Node fetch 强制要求 duplex 选项；
 * 丢失流式能力，但本服务端所有请求体都是小 JSON
 * [CHANGE-IMPACT] 大文件上传路由若接入需重新评估，当前实现会把整个 body 读入内存
 * @param req Node 请求对象
 * @param origin 协议+主机拼接串（如 http://localhost:5173），用于补全相对 url
 */
export async function nodeToFetchRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const url = new URL(req.url || '/', origin)
  const method = (req.method || 'GET').toUpperCase()
  const headers = new Headers()
  const raw = req.headers
  for (const k of Object.keys(raw)) {
    const v = raw[k]
    if (Array.isArray(v)) { for (const one of v) headers.append(k, one)
    }
    else if (typeof v === 'string') { headers.set(k, v)
    }
  }

  // body 用 buffer 读齐，而非 stream —— 避免 Node fetch 强制要求双工选项
  // 权衡：丢失流式传输，但本服务端所有请求体都很小（JSON）
  let body: Uint8Array | undefined
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
    }
    if (chunks.length > 0) body = new Uint8Array(Buffer.concat(chunks))
  }

  return new Request(url.toString(), { method, headers, body: body as RequestInit['body'] })
}

/**
 * 把 fetch Response 的 status / headers / body 写回 Node ServerResponse
 * [WHY] 桥接层另一方向；与 nodeToFetchRequest 配对，覆盖 Hono 路由从进到出的全链路
 * [CONSTRAINT] headers 逐条 setHeader，非法 header 名静默跳过（不阻断响应）
 * [CHANGE-IMPACT] body 逐 chunk 读取并 write，天然支持流式响应（与入向不同）
 * @param res Node 响应对象；函数结束时调用 res.end()
 * @param response 待写回的标准 Response
 */
export async function fetchResponseToNode(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status
  response.headers.forEach((value, key) => {
    try { res.setHeader(key, value) } catch { /* ignore invalid header */ }
  })
  if (!response.body) { res.end(); return }
  const reader = response.body.getReader()
  let done = false
  while (!done) {
    const r = await reader.read()
    if (r.done) { done = true; break }
    if (r.value) res.write(Buffer.from(r.value))
  }
  res.end()
}

/**
 * 从请求头推断当前请求的 origin
 * [WHY] 反代（Nginx 等）场景下 Node 看不到真实协议，靠 x-forwarded-proto 补回
 * [CONSTRAINT] 无 Host 头时回落 localhost；无 x-forwarded-proto 时按 http 处理
 * [CHANGE-IMPACT] origin 结果直接影响 URL 解析与 CSRF 校验（guardRequest 使用同一 host 语义）
 * @param req Node 请求对象
 */
export function inferOrigin(req: IncomingMessage): string {
  const host = (req.headers.host as string) || 'localhost'
  const proto = req.headers['x-forwarded-proto'] || 'http'
  return `${proto}://${host}`
}
