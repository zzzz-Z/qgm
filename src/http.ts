import type { IncomingMessage, ServerResponse } from 'node:http'

export function sendJSON(res: ServerResponse, data: unknown, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

export function sendHTML(res: ServerResponse, html: string) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(html)
}

const MAX_BODY = 5 * 1024 * 1024
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseJSON<T = any>(raw: string): T | null {
  try {
    return raw ? JSON.parse(raw) as T : null
  } catch {
    return null
  }
}

export interface AiRunnerOptions {
  root?: string
  /**
   * 允许非本机 Host（DNS rebinding / --host 暴露到局域网）访问写接口与命令执行端点。
   * 默认 false：检测到 Host 不是 loopback 时，/exec 与 /run 的 shell 分支直接 403。
   */
  allowRemote?: boolean
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

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
    const url = new URL(req.url || '/', 'http://localhost')
    if (url.pathname === '/exec' || url.pathname === '/run') {
      sendJSON(res, { error: '拒绝：dev server 正以非本机 Host 访问，命令执行端点已禁用（aiRunner({ allowRemote: true }) 可显式放开）' }, 403)
      return false
    }
  }
  return true
}
