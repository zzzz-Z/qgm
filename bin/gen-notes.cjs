#!/usr/bin/env node
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const LOGS_DIR = path.join(ROOT, '.ai-runner/logs')
const OUT = path.join(ROOT, 'PROJECT-NOTES.md')
const TTY = Boolean(process.stdout.isTTY)
const c = (n, s) => (TTY ? `\u001B[${n}m${s}\u001B[0m` : s)
const ok = s => console.log(c(32, '✓'), s)
const head = s => console.log(c(36, '▶'), s)

const DAY_MS = 86400000
const KEEP_DAYS = 30
const MAX_ROWS = 50

function readLogs() {
  if (!fs.existsSync(LOGS_DIR)) return []
  const out = []
  for (const f of fs.readdirSync(LOGS_DIR)) {
    if (!f.endsWith('.jsonl')) continue
    const abs = path.join(LOGS_DIR, f)
    let raw
    try { raw = fs.readFileSync(abs, 'utf8') } catch { continue }
    for (const line of raw.split('\n')) {
      const l = line.trim()
      if (!l) continue
      try { out.push(JSON.parse(l)) } catch (e) {}
    }
  }
  return out
}

function fmtDate(ts) {
  const d = new Date(ts)
  const p = n => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

function buildRecent(logs) {
  const cutoff = Date.now() - KEEP_DAYS * DAY_MS
  const recent = logs
    .filter(r => (r.ts || 0) >= cutoff)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, MAX_ROWS)
  if (!recent.length) return ['- （最近 30 天无记录）']
  return recent.map(r => {
    const date = fmtDate(r.ts || 0)
    const desc = String(r.desc || '').slice(0, 60) || ('exit ' + r.exit)
    const files = Array.isArray(r.changes) ? r.changes.length : (r.changeCount || 0)
    return '- ' + date + ' · `' + (r.runId || '') + '` · ' + files + ' 文件 · ' + desc
  })
}

function buildDecisions(logs) {
  const seen = new Set()
  const out = []
  for (const r of logs.slice(-200).reverse()) {
    const why = String(r.why || '').trim()
    if (!why || why.length < 6) continue
    if (seen.has(why)) continue
    seen.add(why)
    out.push('- ' + why.slice(0, 120))
    if (out.length >= 15) break
  }
  if (!out.length) return ['- （暂无记录）']
  return out
}

function buildArchitecture() {
  const lines = []
  if (fs.existsSync(path.join(ROOT, 'src'))) lines.push('- `src/` Vite 插件（Node 侧）')
  if (fs.existsSync(path.join(ROOT, 'client'))) lines.push('- `client/` 工作台 SPA（Vue 3）')
  if (fs.existsSync(path.join(ROOT, 'bin'))) lines.push('- `bin/` CLI 工具')
  if (fs.existsSync(path.join(ROOT, 'skills'))) lines.push('- `skills/` AI 协作规则')
  if (!lines.length) return ['- （无）']
  return lines
}

head('gen-notes')
const logs = readLogs()
console.log('  日志条数:', logs.length)

const md = [
  '# PROJECT-NOTES',
  '',
  '> 自动生成于 ' + new Date().toISOString(),
  '',
  '## Recent Changes（30 天滚动）',
  '',
  ...buildRecent(logs),
  '',
  '## Architecture（当前事实）',
  '',
  ...buildArchitecture(),
  '',
  '## Decisions（决策因果）',
  '',
  ...buildDecisions(logs),
  '',
].join('\n')

fs.writeFileSync(OUT, md)
ok('已生成 ' + path.relative(ROOT, OUT))
console.log('  行数: ' + md.split('\n').length)
