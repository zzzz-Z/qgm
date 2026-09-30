// [arch-hono/skills-v1] skills 路由 Hono 版（fetch handler；语义与原 routes/skills.ts 对齐）
import { Hono } from 'hono'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { getRoot } from '../config.js'
import { clearRulesHashCache } from '../post-run/compliance.js'
import { installFromGithub, searchGithubSkills } from '../skills/github-skills.js'
import type { GithubSkillCandidate } from '../skills/github-skills.js'

interface SkillEntry { name: string, content: string, source: string }

/** 默认加载的 skill 名称列表 */
const DEFAULT_SKILLS = new Set(['core-behavior', 'core-loop-protocol', 'script-standards', 'script-ai-api', 'env-preflight'])

/** skills 路由的 Hono 实例 */
/** skills 路由的 Hono 实例 */
export const skillsHono = new Hono()

/** [runner-own-skills-v1] 从 AI Runner 自身安装位置解析 skills 目录（向上最多 6 层找含 _loader.cjs 的 skills/） */
function resolveRunnerSkillsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  let dir = here
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'skills')
    if (fs.existsSync(path.join(candidate, '_loader.cjs'))) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.join(getRoot(), 'skills') // 兜底：兼容旧行为
}

skillsHono.get('/skills/always', (c) => {
  try {
    const require = createRequire(import.meta.url)
    const loaderPath = path.join(resolveRunnerSkillsDir(), '_loader.cjs')
    try { delete require.cache[require.resolve(loaderPath)] } catch { /* ignore */ }
    const loader = require(loaderPath) as { load: (keys: string[]) => string, ALWAYS_KEYS: string[] }
    const text = loader.load(loader.ALWAYS_KEYS)
    return c.json({ ok: true, text, keys: loader.ALWAYS_KEYS })
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500)
  }
})

skillsHono.get('/skills', (c) => {
  const baseDir = resolveRunnerSkillsDir()
  const userDir = path.join(getRoot(), '.ai-runner/skills')
  const agentsDir = path.join(os.homedir(), '.agents/skills')
  const collect = (dir: string, source: string): SkillEntry[] => {
    if (!fs.existsSync(dir)) return []
    const out: SkillEntry[] = []
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
        try { out.push({ name: rel, content: fs.readFileSync(full, 'utf8'), source }) } catch { /* skip */ }
      }
    }
    walkDir(dir, '')
    return out
  }
  const collectAgents = (dir: string): SkillEntry[] => {
    if (!fs.existsSync(dir)) return []
    const out: SkillEntry[] = []
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
        try { out.push({ name: `${ent.name}/${base}`, content: fs.readFileSync(abs, 'utf8'), source: 'agents' }) } catch { /* skip */ }
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
  return c.json(merged.map(s => ({ ...s, default: DEFAULT_SKILLS.has(s.name) })))
})

/** [github-skills-v1] GET /skills/github/search?q=<keyword>&limit=<n>：搜索 GitHub 上的 SKILL.md */
skillsHono.get('/skills/github/search', async (c) => {
  const q = String(c.req.query('q') || '').trim()
  if (!q) return c.json({ ok: false, items: [], total: 0, error: 'q 为空' }, 400)
  const limit = Math.max(1, Math.min(30, Number(c.req.query('limit') || 10) || 10))
  const r = await searchGithubSkills(q, limit)
  return c.json(r, r.ok ? 200 : (r.rateLimited ? 429 : 502))
})

/** [github-skills-v1] POST /skills/github/install { candidate, name? }：拉取并落盘到 .ai-runner/skills/ */
skillsHono.post('/skills/github/install', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { candidate?: GithubSkillCandidate, name?: string } | null
  const cand = body && body.candidate
  if (!cand || !cand.repo || !cand.filePath) {
    return c.json({ ok: false, error: 'candidate.repo / candidate.filePath 必填' }, 400)
  }
  const r = await installFromGithub(cand, body && body.name ? String(body.name) : undefined)
  if (!r.ok) return c.json(r, 400)
  clearRulesHashCache()
  return c.json(r)
})

skillsHono.post('/skills', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { name?: string, content?: string } | null
  const name = String(body?.name || '').trim()
  const content = String(body?.content || '')
  if (!name || !/^[\w.-]+$/.test(name) || name.includes('..') || name.length > 64) {
    return c.json({ error: '名字只允许字母数字 _ . -，1-64 字符' }, 400)
  }
  const dir = path.join(getRoot(), '.ai-runner/skills')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${name}.md`), content, 'utf8')
  clearRulesHashCache()
  return c.json({ ok: true })
})

skillsHono.delete('/skills', (c) => {
  const name = String(c.req.query('name') || '').trim()
  if (!name || !/^[\w.-]+$/.test(name) || name.includes('..')) {
    return c.json({ error: '名字非法' }, 400)
  }
  const file = path.join(getRoot(), '.ai-runner/skills', `${name}.md`)
  if (fs.existsSync(file)) fs.unlinkSync(file)
  clearRulesHashCache()
  return c.json({ ok: true })
})
