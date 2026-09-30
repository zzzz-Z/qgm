// [logs-route-v1] /logs 路由：读 .ai-runner/logs/*.jsonl（方案A：会话记录数据源从 localStorage 迁到磁盘）
import { Hono } from 'hono'
import fs from 'node:fs'
import path from 'node:path'
import { getRoot } from '../config.js'

interface LogEntry {
  ts: number
  runId?: string
  desc?: string
  why?: string
  script?: string
  exit?: number
  durationMs?: number
  changeCount?: number
  errorFiles?: string[]
  changes?: Array<{ path: string, type: string }>
  [k: string]: unknown
}

/** logs 路由的 Hono 实例 */
export const logsHono = new Hono()

// 读取 logs 目录下的 .jsonl 文件清单
logsHono.get('/logs/list', (c) => {
  const dir = path.join(getRoot(), '.ai-runner', 'logs')
  if (!fs.existsSync(dir)) return c.json({ files: [] })
  let files: Array<{ name: string, size: number, mtime: number, lines: number }> = []
  try {
    files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map((f) => {
        const full = path.join(dir, f)
        const st = fs.statSync(full)
        let lines = 0
        try { lines = fs.readFileSync(full, 'utf8').split('\n').filter(Boolean).length } catch { /* ignore */ }
        return { name: f, size: st.size, mtime: st.mtimeMs, lines }
      })
      .sort((a, b) => b.mtime - a.mtime)
  } catch { /* ignore */ }
  return c.json({ files })
})

// 查询日志：支持 file / limit / offset / filter(kind=all|success|fail) / q(搜索)
logsHono.get('/logs/query', (c) => {
  const q = c.req.query()
  const file = String(q.file || '').trim()
  const limit = Math.max(1, Math.min(500, Number(q.limit) || 100))
  const offset = Math.max(0, Number(q.offset) || 0)
  const filter = String(q.filter || 'all')
  const search = String(q.q || '').trim().toLowerCase()
  const dir = path.join(getRoot(), '.ai-runner', 'logs')
  if (!fs.existsSync(dir)) return c.json({ entries: [], total: 0, files: [] })

  // 选文件：指定 file 只读一个；否则合并读最近 N 个文件
  let files: string[]
  if (file) {
    if (!/^[\w.-]+\.jsonl$/.test(file)) return c.json({ error: '非法文件名' }, 400)
    files = [file]
  } else {
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort()
    } catch { files = [] }
  }

  // 逐行解析（最旧→新，便于统一排序）
  const all: LogEntry[] = []
  for (const f of files) {
    const full = path.join(dir, f)
    let raw: string
    try { raw = fs.readFileSync(full, 'utf8') } catch { continue }
    for (const line of raw.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try { all.push(JSON.parse(t) as LogEntry) } catch { /* skip bad line */ }
    }
  }

  // 倒序（新→旧）
  all.sort((a, b) => (b.ts || 0) - (a.ts || 0))

  // 过滤
  let filtered = all
  if (filter === 'success') filtered = filtered.filter(e => (e.exit || 0) === 0)
  else if (filter === 'fail') filtered = filtered.filter(e => (e.exit || 0) !== 0)
  if (search) {
    filtered = filtered.filter((e) => {
      const bag = [e.desc, e.why, e.script, e.runId].filter(Boolean).join(' ').toLowerCase()
      return bag.includes(search)
    })
  }

  const total = filtered.length
  const entries = filtered.slice(offset, offset + limit)
  return c.json({ entries, total, files })
})
