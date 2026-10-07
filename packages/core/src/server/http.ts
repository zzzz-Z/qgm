import type { IncomingMessage, ServerResponse } from 'node:http'

/** AiRunner 服务配置：端口、工作目录、日志、白名单 */
export interface AiRunnerOptions {
  root?: string
  /**
   * 允许非本机 Host（DNS rebinding / --host 暴露到局域网）访问写接口与命令执行端点。
   * 默认 false：检测到 Host 不是 loopback 时，/exec 与 /run 的 shell 分支直接 403。
   */
  allowRemote?: boolean
}

/** 请求体最大字节数（防止超大请求耗尽内存） */
const MAX_BODY = 5 * 1024 * 1024

/** 允许的本机回环主机名（防止 SSRF） */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/**
 * 写出 JSON 响应
 * [CONSTRAINT] Content-Type 固定 application/json + charset=utf-8；响应体走 JSON.stringify，
 * 循环引用会抛错（调用方需自行保证 data 可序列化）
 * [CHANGE-IMPACT] guardRequest 的 403/415 拒绝路径依赖本函数，改 header 会破坏 CSRF 防护约定
 * @param res HTTP 响应对象
 * @param body 任意可 JSON 序列化的值
 * @param code HTTP 状态码，默认 200
 */
export function sendJSON(res: ServerResponse, body: unknown, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * 写出 HTML 响应（状态码固定 200）
 * [CONSTRAINT] Content-Type 固定 text/html + charset=utf-8；调用方负责 HTML 转义，本函数不做过滤
 */
export function sendHTML(res: ServerResponse, html: string) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(html)
}
/**
 * 读取请求体文本，超过 MAX_BODY 立即中断
 * [WHY] 缓冲超大请求会耗尽内存；达到上限时 destroy 连接并 resolve 空串（调用方判空即为拒绝）
 * [CONSTRAINT] 依赖 req.destroy() 触发 error 事件但以 over 标志抑制重复 resolve；
 * 溢出与读取错误都返回空串，调用方无法区分两者
 * [CHANGE-IMPACT] MAX_BODY 影响路由处理上限，调小需同步检查 /run 脚本大小
 */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = ''
    let over = false
    req.on('data', (c: Buffer) => {
      if (over) return
      body += c.toString()
      if (body.length > MAX_BODY) {
        over = true
        req.destroy()
        resolve('')
      }
    })
    req.on('end', () => { if (!over) resolve(body) })
    req.on('error', () => { if (!over) resolve(body) })
  })
}

/**
 * 容错 JSON 解析
 * [CONSTRAINT] 空串与非法 JSON 均返回 null（不区分）；解析异常不抛错
 * [CHANGE-IMPACT] 调用方需判 null 而非 falsy，因为合法值 false / 0 也会被 typeof 命中
 * @param raw 请求体原文
 */
export function parseJSON<T = any>(raw: string): T | null {
  try {
    return raw ? JSON.parse(raw) as T : null
  } catch {
    return null
  }
}

/**
 * 判断 Host 头是否指向本机回环地址
 * [WHY] SSRF / DNS-rebinding 防护：仅本机访问的 dev server 不应响应外部 Host 的命令执行端点
 * [CONSTRAINT] 取逗号分隔的第一段（代理链场景）；IPv6 用 [::1] 形式含方括号匹配；
 * 空 header 视为 loopback（兼容本地无 Host 直连）
 * [CHANGE-IMPACT] 误判 true 会绕过 guardRequest 的 allowRemote 检查
 * @param hostHeader 原始 Host 头值，可含端口；undefined 视为本机
 */
function hostIsLoopback(hostHeader?: string): boolean {
  if (!hostHeader) return true
  const host = hostHeader.split(',')[0].trim()
  const hostname = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : host.split(':')[0]
  return LOOPBACK_HOSTS.has(hostname)
}

/**
 * CSRF / DNS-rebinding 防护。返回 false 表示已回写拒绝响应。
 * - 写接口强制 application/json：跨域简单请求（form / text/plain）无法伪装
 * - 带 Origin 时必须与 Host 同源
 * - 非 loopback Host 默认禁止任意命令执行端点（/exec、/run）
 */
export function guardRequest(req: IncomingMessage, res: ServerResponse, options: AiRunnerOptions): boolean {
  const method = req.method || 'GET'
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true

  // POST 是唯一可被跨域「简单请求」伪装的写方法（form / text-plain 不触发预检），强制 JSON
  if (method === 'POST') {
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
    if (ct !== 'application/json') {
      sendJSON(res, { error: '拒绝：仅接受 application/json 请求（CSRF 防护）' }, 415)
      return false
    }
  }
  const origin = req.headers.origin
  if (origin) {
    let ok: boolean
    try {
      ok = new URL(origin).host === String(req.headers.host || '')
    } catch { ok = false }
    if (!ok) {
      sendJSON(res, { error: '拒绝：跨域请求被拦截（Origin 与 Host 不一致）' }, 403)
      return false
    }
  }
  if (!options.allowRemote && !hostIsLoopback(String(req.headers.host || ''))) {
    // [url-parse-guard-v3] req.url 是任意字节串：`POST // HTTP/1.1` + `Content-Type: application/json`
    //   + 非 loopback Host 会走到这里，旧实现下 new URL('//', 'http://localhost') 抛 ERR_INVALID_URL
    //   ⇒ 抛穿到 router 调用方的 .catch ⇒ 客户端过错被记成 500 服务端故障。
    // [WHY] 不在本函数发 400：guardRequest 是**安全闸门**（CSRF / DNS-rebinding），不是路由，
    //   它此刻还**没有解析结果**可用；而无法解析的目标**不可能**是 /exec 或 /run，
    //   所以解析失败即视为「无需拦截」，放行交给 handle() 统一判 400。
    // [CHANGE-IMPACT] 解析失败从「抛穿 → 500」变为「放行 → handle 的 400」；对 /exec、/run 的拦截语义不变。
    let pathname = ''
    try {
      pathname = new URL(req.url || '/', 'http://localhost').pathname
    } catch {
      pathname = ''
    }
    if (pathname === '/exec' || pathname === '/run') {
      sendJSON(res, { error: '拒绝：dev server 正以非本机 Host 访问，命令执行端点已禁用（aiRunner({ allowRemote: true }) 可显式放开）' }, 403)
      return false
    }
  }
  return true
}

// re-export for downstream convenience
export type { IncomingMessage, ServerResponse } from 'node:http'
