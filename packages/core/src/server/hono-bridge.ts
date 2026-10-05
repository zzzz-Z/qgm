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
 * [CONSTRAINT] 无 Host 头时回落 localhost；x-forwarded-proto 只认 http/https，且取**第一段**；
 * 拼不出的 origin 一律回落 http://localhost（见 [origin-guard-v1]）
 * [CHANGE-IMPACT] origin 结果直接影响 URL 解析与 CSRF 校验（guardRequest 使用同一 host 语义）
 * @param req Node 请求对象
 */
export function inferOrigin(req: IncomingMessage): string {
  // [origin-guard-v1] Host 与 x-forwarded-proto 都是**任意字节串** —— Node 只挡控制字符，
  //   不校验二者的语义。而 `${proto}://${host}` 会被 nodeToFetchRequest 当作 base
  //   （`new URL(req.url, origin)`）⇒ 拼不出合法 URL 就抛 ERR_INVALID_URL，
  //   被调用方的 .catch 统一记成 **500 服务端故障**（实为客户端请求头畸形）。
  // [实测] `.ai-runner/tmp/d16-host-probe.cjs` 对活实例打 5 例 500：
  //   `Host: a b`、`Host: %`、`Host: [`、`X-Forwarded-Proto: file`、
  //   `X-Forwarded-Proto: https, http` —— 最后一项**真实反代就会发**（逗号列表），不只是攻击面。
  // [WHY] 兜底就放在这里而不是 handle：本函数的契约本来就是「给出一个可用的 origin」，
  //   换了别的层都只是把问题推给下一个调用者。
  // [CONSTRAINT] 回落只给 http://localhost，**不按 host 反查 DNS**：invalid host 不可能是
  //   可解析的主机名，故不引入 rebinding 面；且 origin 仅用于补全 url，路由只匹配 pathname。
  // [CHANGE-IMPACT] 畸形 Host / proto 由「500 + 堆栈噪音」变为「按 localhost 正常处理」；
  //   合法 https 反代、带端口 Host、IPv6 Host 的返回值**逐字不变**。
  //   由 url-parse-guard.node-test.ts 的行为用例守卫。
  const rawHost = (req.headers.host as string) || 'localhost'
  const rawProto = String(req.headers['x-forwarded-proto'] || 'http')
    .split(',')[0]
    .trim()
    .toLowerCase()
  const proto = rawProto === 'https' ? 'https' : 'http'
  const candidate = `${proto}://${rawHost}`
  try {
    const parsed = new URL(candidate)
    // 只借「能否解析」这一事实；返回原串而非 parsed.origin，以免改动既有字符串行为
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? candidate : 'http://localhost'
  } catch {
    return 'http://localhost'
  }
}
