#!/usr/bin/env node
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const CONFIG = path.join(ROOT, '.ai-runner/config.json')
const L = require('../src/logger.cjs')

const err = s => L.err(s)

function loadConfig() {
  const env = process.env.DEEPSEEK_API_KEY
  if (env) return { apiKey: env, baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' }
  try {
    if (!fs.existsSync(CONFIG)) return null
    const j = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
    const d = j.deepseek || {}
    if (!d.apiKey) return null
    return {
      apiKey: d.apiKey,
      baseUrl: d.baseUrl || 'https://api.deepseek.com',
      model: d.model || 'deepseek-chat',
    }
  } catch { return null }
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('')
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (d) => { buf += d })
    process.stdin.on('end', () => resolve(buf))
    process.stdin.resume()
  })
}

async function main() {
  const args = process.argv.slice(2)
  let prompt = args.join(' ').trim()
  if (!prompt) prompt = (await readStdin()).trim()
  if (!prompt) { err('用法：node plugins/ai-ask.cjs "问题"  或  echo 问题 | node plugins/ai-ask.cjs'); process.exit(2) }

  const cfg = loadConfig()
  if (!cfg) {
    err('未找到 API key。设置环境变量 DEEPSEEK_API_KEY=sk-... 或写入 .ai-runner/config.json:')
    err('  { "deepseek": { "apiKey": "sk-...", "baseUrl": "https://api.deepseek.com", "model": "deepseek-chat" } }')
    process.exit(3)
  }

  const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`
  const body = JSON.stringify({
    model: cfg.model,
    stream: true,
    messages: [{ role: 'user', content: prompt }],
  })

  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey}`,
      },
      body,
    })
  } catch (e) {
    err(`请求失败：${String(e)}`)
    process.exit(4)
  }

  if (!res.ok) {
    let detail = ''
    try { detail = await res.text() } catch {}
    err(`HTTP ${res.status} ${res.statusText}${detail ? `\n${detail.slice(0, 500)}` : ''}`)
    process.exit(5)
  }

  const reader = res.body.getReader()
  const dec = new TextDecoder('utf8')
  let buf = ''
  let usage = null
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
        const j = JSON.parse(payload)
        const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content
        if (delta) process.stdout.write(delta)
        if (j.usage) usage = j.usage
      } catch {}
    }
  }
  process.stdout.write('\n')
  if (usage && process.stdout.isTTY) {
    L.info(`tokens: prompt=${usage.prompt_tokens || 0} completion=${usage.completion_tokens || 0}`)
  }
}

main().catch((e) => { err(String((e && e.stack) || e)); process.exit(1) })
