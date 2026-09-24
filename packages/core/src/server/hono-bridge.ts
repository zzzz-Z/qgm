// [arch-hono] HTTP 层桥接：Node IncomingMessage/ServerResponse ↔ fetch Request/Response
// 目标：路由实现只依赖 fetch 语义，Node 差异在此处吸收
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * 执行 node To Fetch Request
 * @param req - req
 * @param origin - origin
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
 * 拉取 Response To Node
 * @param res - res
 * @param response - response
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
 * 执行 infer Origin
 * @param req - req
 */
export function inferOrigin(req: IncomingMessage): string {
  const host = (req.headers.host as string) || 'localhost'
  const proto = req.headers['x-forwarded-proto'] || 'http'
  return `${proto}://${host}`
}
