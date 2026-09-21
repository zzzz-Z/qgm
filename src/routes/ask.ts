// /ask —— DeepSeek SSE 代理
import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { getRoot } from '../config.js'
import { parseJSON, readBody, sendJSON } from '../server/http.js'

/** POST /ask { prompt, model } → SSE 流式转发 DeepSeek */
export async function handleAskRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (req.method !== 'POST' || url.pathname !== '/ask') return false
  const body = parseJSON<{ prompt?: string, model?: string }>(await readBody(req))
  const prompt = String(body?.prompt || '').trim()
  if (!prompt) { sendJSON(res, { error: 'prompt 为空' }, 400); return true }
  let apiKey = process.env.DEEPSEEK_API_KEY || ''
  let baseUrl = 'https://api.deepseek.com'
  let model = body?.model || 'deepseek-chat'
  if (!apiKey) {
    try {
      const cfgPath = path.join(getRoot(), '.ai-runner/config.json')
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
        const d = cfg.deepseek || {}
        if (d.apiKey) apiKey = String(d.apiKey)
        if (d.baseUrl) baseUrl = String(d.baseUrl)
        if (!body?.model && d.model) model = String(d.model)
      }
    } catch { /* ignore */ }
  }
  if (!apiKey) { sendJSON(res, { error: '未配置 DeepSeek API key（env DEEPSEEK_API_KEY 或 .ai-runner/config.json）' }, 400); return true }
  let upstream: Response
  try {
    upstream = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: prompt }] }),
    })
  } catch (e) {
    sendJSON(res, { error: `上游请求失败：${String(e)}` }, 502)
    return true
  }
  if (!upstream.ok) {
    let detail = ''
    try { detail = await upstream.text() } catch { /* ignore */ }
    sendJSON(res, { error: `上游 HTTP ${upstream.status}${detail ? `：${detail.slice(0, 300)}` : ''}` }, 502)
    return true
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
    'Connection': 'keep-alive',
  })
  const reader = upstream.body!.getReader()
  const dec = new TextDecoder('utf8')
  let buf = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '')
        buf = buf.slice(idx + 1)
        if (!line.startsWith('data: ')) continue
        const payload = line.slice(6)
        if (payload === '[DONE]') continue
        try {
          const j2 = JSON.parse(payload)
          const delta = j2?.choices?.[0]?.delta?.content
          if (delta) res.write(`data: ${JSON.stringify({ delta })}\n\n`)
          if (j2?.usage) res.write(`data: ${JSON.stringify({ usage: j2.usage })}\n\n`)
        } catch { /* ignore */ }
      }
    }
    res.write('data: [DONE]\n\n')
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: String(e) })}\n\n`)
  }
  res.end()
  return true
}
