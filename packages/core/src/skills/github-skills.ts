// [github-skills-v1] 从 GitHub 搜索并安装 skill（SKILL.md）
// [WHY] 现有 loader 只扫本地目录；用户希望按需从 GitHub 动态发现相关 skill
// [CONSTRAINT] Code Search API 未认证 10 req/min；raw 拉取无认证门槛
// [CHANGE-IMPACT] 安装落到 .ai-runner/skills/，与 POST /skills 写同一目录，下次 loader.scan() 会拾取

import fs from 'node:fs'
import path from 'node:path'
import { getRoot } from '../config.js'

/** GitHub Code Search 单条命中 */
export interface GithubSkillCandidate {
  repo: string
  filePath: string
  htmlUrl: string
  sha: string
  score: number
}

/** 搜索结果 */
export interface GithubSearchResult {
  ok: boolean
  items: GithubSkillCandidate[]
  total: number
  error?: string
  rateLimited?: boolean
}

/** 安装结果 */
export interface GithubInstallResult {
  ok: boolean
  name?: string
  file?: string
  bytes?: number
  error?: string
}

const UA = 'ai-runner-skill-fetcher'
const API = 'https://api.github.com'

/** 组装 API 请求头；有 GITHUB_TOKEN 时带 Bearer 提升限额 */
function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Accept': 'application/vnd.github+json', 'User-Agent': UA }
  const t = process.env.GITHUB_TOKEN
  if (t) h.Authorization = `Bearer ${t}`
  return h
}

/**
 * 搜索 GitHub 上的 SKILL.md 文件
 * [WHY] filename:SKILL.md 限定命中类型；关键词可在路径/内容上匹配
 * [CONSTRAINT] 未认证 10 req/min；403/429 归为 rateLimited 让调用方提示配置 token
 */
export async function searchGithubSkills(query: string, limit = 10): Promise<GithubSearchResult> {
  const q = String(query || '').trim()
  if (!q) return { ok: false, items: [], total: 0, error: 'query empty' }
  const qstr = `${q} filename:SKILL.md`
  const per = Math.max(1, Math.min(30, limit))
  const url = `${API}/search/code?q=${encodeURIComponent(qstr)}&per_page=${per}`
  try {
    const r = await fetch(url, { headers: authHeaders() })
    if (r.status === 403 || r.status === 429) {
      return { ok: false, items: [], total: 0, error: `GitHub rate limited (HTTP ${r.status})`, rateLimited: true }
    }
    if (!r.ok) return { ok: false, items: [], total: 0, error: `GitHub HTTP ${r.status}` }
    type RawItem = Record<string, unknown> & { repository?: { full_name?: string }, html_url?: string, sha?: string, score?: number }
    const j = await r.json() as { total_count?: number, items?: RawItem[] }
    const items: GithubSkillCandidate[] = (j.items || []).slice(0, per).map((it) => {
      const fp = String(it.path || '')
      return {
        repo: String((it.repository && it.repository.full_name) || ''),
        filePath: fp,
        htmlUrl: String(it.html_url || ''),
        sha: String(it.sha || ''),
        score: Number(it.score || 0),
      }
    })
    return { ok: true, items, total: Number(j.total_count || 0) }
  } catch (e) {
    return { ok: false, items: [], total: 0, error: String(e) }
  }
}

/**
 * 拉取指定 repo/filePath 的 SKILL.md 原文
 * [WHY] raw.githubusercontent.com 不走 API 限额，未认证也可拉公开仓库
 * [CONSTRAINT] ref 默认 HEAD；filePath 需带 .md 后缀
 */
export async function fetchSkillMarkdown(repo: string, filePath: string, ref = 'HEAD'): Promise<{ ok: boolean, content?: string, error?: string }> {
  const r = String(repo || '').trim()
  const p = String(filePath || '').trim().replace(/^\/+/, '')
  if (!r || !p) return { ok: false, error: 'repo / filePath required' }
  const url = `https://raw.githubusercontent.com/${r}/${encodeURIComponent(ref)}/${p}`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } })
    if (!res.ok) return { ok: false, error: `raw HTTP ${res.status}` }
    const content = await res.text()
    return { ok: true, content }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

/**
 * 把 skill 内容落到 .ai-runner/skills/<name>.md
 * [CONSTRAINT] 名字白名单同 POST /skills 路由：字母数字 _ . -，1-64 字符，禁 ..
 * [CHANGE-IMPACT] 与 POST /skills 写同一目录；安装后需 clearRulesHashCache 才刷新 hash 分组
 */
export function installSkillFile(name: string, content: string): GithubInstallResult {
  const n = String(name || '').trim()
  if (!n || !/^[\w.-]+$/.test(n) || n.includes('..') || n.length > 64) {
    return { ok: false, error: 'invalid name' }
  }
  if (!content) return { ok: false, error: 'content empty' }
  try {
    const dir = path.join(getRoot(), '.ai-runner', 'skills')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${n}.md`)
    fs.writeFileSync(file, content, 'utf8')
    return { ok: true, name: n, file, bytes: content.length }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

/**
 * 组合：从候选拉取 + 安装
 * [WHY] 调用方（路由）只需一次调用即可完成搜索-预览-落盘链路
 * [CONSTRAINT] 默认名取 filePath 中 SKILL.md 上一级目录名
 */
export async function installFromGithub(candidate: GithubSkillCandidate, nameOverride?: string): Promise<GithubInstallResult> {
  const got = await fetchSkillMarkdown(candidate.repo, candidate.filePath, 'HEAD')
  if (!got.ok || !got.content) return { ok: false, error: got.error || 'fetch failed' }
  const segs = candidate.filePath.split('/').filter(Boolean)
  const parent = segs.length >= 2 ? segs[segs.length - 2] : ''
  const fallback = candidate.repo.replace('/', '-')
  const name = nameOverride || parent || fallback
  return installSkillFile(name, got.content)
}
