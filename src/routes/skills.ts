// /skills GET/POST/DELETE
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { getRoot } from '../config.js'
import { clearRulesHashCache } from '../post-run/compliance.js'
import { parseJSON, readBody, sendJSON } from '../server/http.js'
import type { IncomingMessage, ServerResponse } from '../server/http.js'

// 常驻 skill：与 skills/_loader.cjs 的 ALWAYS_KEYS 对齐
const DEFAULT_SKILLS = new Set(['core-behavior', 'core-loop-protocol', 'script-standards', 'script-ai-api', 'env-preflight'])

/** /skills 列表 / 新建 / 删除 */
export async function handleSkillsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  // ---------- Skills ----------
  if (req.method === 'GET' && url.pathname === '/skills/always') {
    try {
      const require = createRequire(import.meta.url)
      const loaderPath = path.join(getRoot(), 'skills/_loader.cjs')
      // 清 require 缓存，确保 dev server 加载最新 _loader.cjs（ALWAYS_KEYS 会随版本变化）
      try { delete require.cache[require.resolve(loaderPath)] } catch { /* ignore */ }
      const loader = require(loaderPath)
      const text = loader.load(loader.ALWAYS_KEYS)
      sendJSON(res, { ok: true, text, keys: loader.ALWAYS_KEYS })
    } catch (e) {
      sendJSON(res, { ok: false, error: String(e) }, 500)
    }
    return true
  }
  if (req.method === 'GET' && url.pathname === '/skills') {
    const baseDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../skills')
    const userDir = path.join(getRoot(), '.ai-runner/skills')
    const agentsDir = path.join(os.homedir(), '.agents/skills')
    const collect = (dir: string, source: string) => {
      if (!fs.existsSync(dir)) return [] as Array<{ name: string, content: string, source: string }>
      const out: Array<{ name: string, content: string, source: string }> = []
      const walkDir = (d: string, prefix: string) => {
        let ents: fs.Dirent[]
        try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
        for (const ent of ents) {
          if (ent.name.startsWith('.')) continue
          const full = path.join(d, ent.name)
          const base = ent.name.endsWith('.md') ? ent.name.slice(0, -3) : ent.name
          const rel = prefix ? `${prefix}-${base}` : base
          if (ent.isDirectory()) { walkDir(full, rel); continue }
          if (!ent.name.endsWith('.md')) continue
          if (ent.name === 'INDEX.md') continue
          try {
            out.push({ name: rel, content: fs.readFileSync(full, 'utf8'), source })
          } catch {}
        }
      }
      walkDir(dir, '')
      return out
    }
    const collectAgents = (dir: string) => {
      if (!fs.existsSync(dir)) return [] as Array<{ name: string, content: string, source: string }>
      const out: Array<{ name: string, content: string, source: string }> = []
      const SKIP = new Set(['LICENSE', 'CHANGELOG', 'SYNC'])
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue
        const sub = path.join(dir, ent.name)
        let files: string[]
        try { files = fs.readdirSync(sub).filter(f => f.endsWith('.md')) } catch { continue }
        for (const f of files) {
          const base = f.slice(0, -3)
          if (SKIP.has(base)) continue
          const abs = path.join(sub, f)
          try {
            out.push({ name: `${ent.name}/${base}`, content: fs.readFileSync(abs, 'utf8'), source: 'agents' })
          } catch {}
        }
      }
      return out
    }
    const base = collect(baseDir, 'base')
    const agents = collectAgents(agentsDir)
    const user = collect(userDir, 'user')
    const names = new Set(user.map(s => s.name))
    const merged = [
      ...base.filter(s => !names.has(s.name)),
      ...agents.filter(s => !names.has(s.name)),
      ...user,
    ]
    merged.sort((a, b) => a.name.localeCompare(b.name))
    const withDefault = merged.map(s => ({ ...s, default: DEFAULT_SKILLS.has(s.name) }))
    sendJSON(res, withDefault); return true
  }

  if (req.method === 'POST' && url.pathname === '/skills') {
    const body = parseJSON<{ name?: string, content?: string }>(await readBody(req))
    const name = String(body?.name || '').trim()
    const content = String(body?.content || '')
    if (!name || !/^[\w.-]+$/.test(name) || name.includes('..') || name.length > 64) {
      sendJSON(res, { error: '名字只允许字母数字 _ . -，1-64 字符' }, 400); return true
    }
    const dir = path.join(getRoot(), '.ai-runner/skills')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${name}.md`), content, 'utf8')
    clearRulesHashCache()
    sendJSON(res, { ok: true }); return true
  }

  if (req.method === 'DELETE' && url.pathname === '/skills') {
    const name = String(url.searchParams.get('name') || '').trim()
    if (!name || !/^[\w.-]+$/.test(name) || name.includes('..')) {
      sendJSON(res, { error: '名字非法' }, 400); return true
    }
    const file = path.join(getRoot(), '.ai-runner/skills', `${name}.md`)
    if (fs.existsSync(file)) fs.unlinkSync(file)
    clearRulesHashCache()
    sendJSON(res, { ok: true }); return true
  }
  return false
}
