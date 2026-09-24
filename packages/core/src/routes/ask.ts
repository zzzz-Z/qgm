// [arch-hono/ask-v1] /ask 路由 Hono 版（SSE 流式代理 DeepSeek）
import { Hono } from 'hono'
import fs from 'node:fs'
import path from 'node:path'
import { getRoot } from '../config.js'

/** ask 路由的 Hono 实例 */
export const askHono = new Hono()

askHono.post('/ask', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { prompt?: string, model?: string } | null
  const prompt = String(body?.prompt || '').trim()
  if (!prompt) return c.json({ error: 'prompt 为空' }, 400)

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
  if (!apiKey) {
    return c.json({ error: '未配置 DeepSeek API key（env DEEPSEEK_API_KEY 或 .ai-runner/config.json）' }, 400)
  }

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
    return c.json({ error: `上游请求失败：${String(e)}` }, 502)
  }
  if (!upstream.ok) {
    let detail = ''
    try { detail = await upstream.text() } catch { /* ignore */ }
    return c.json({ error: `上游 HTTP ${upstream.status}${detail ? `：${detail.slice(0, 300)}` : ''}` }, 502)
  }
  if (!upstream.body) return c.json({ error: '上游无 body' }, 502)

  // 手动 SSE 解析：把上游 chat/completions 分块转成 { delta } / { usage } 帧
  const enc = new TextEncoder()
  const dec = new TextDecoder('utf8')
  const reader = upstream.body.getReader()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
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
              if (delta) controller.enqueue(enc.encode(`data: ${JSON.stringify({ delta })}\n\n`))
              if (j2?.usage) controller.enqueue(enc.encode(`data: ${JSON.stringify({ usage: j2.usage })}\n\n`))
            } catch { /* ignore */ }
          }
        }
        controller.enqueue(enc.encode('data: [DONE]\n\n'))
      } catch (e) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ error: String(e) })}\n\n`))
      }
      controller.close()
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
      'Connection': 'keep-alive',
    },
  })
})
