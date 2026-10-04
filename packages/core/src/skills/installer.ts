// [skills-install-v1] 本地优先进安装：**已装 → 本地库 → 远端下载**，顺序由代码强制。
// [WHY] 旧流程只在 SKILL.md 里用散文要求「先查 registry」，而 registry 会与磁盘漂移（假阴性）→
//   AI 认为没装 → 在 /run 沙盒里手搓 curl/fetch 拉 21 个文件 → 必撞 60s 硬超时（实测 66.2s / exit -1），
//   而文件其实已写完 → 「一直安装失败」的自增强死循环。把顺序搬进代码即可根治：
//   ①本地已装 = 0 网络 ②本地库命中 = 0 网络 ③只有真缺才联网，且**不在沙盒里跑**（服务端无 60s 上限）。
// [CONSTRAINT] 安全边界：主机白名单 https + 技能名/仓库/路径/ref 全部正则校验 + 逐文件路径越界防护 +
//   单文件/总字节/文件数三上限 + 单请求与总预算双超时。远端内容一律先落本地库再复制，绝不直接执行。
// [CHANGE-IMPACT] 由 routes/skills.ts 的 POST /skills/install 调用；写后统一 reconcile registry。
import fs from 'node:fs'
import path from 'node:path'
import { parseFrontmatter } from './frontmatter.js'
import { listInstalledNames, reconcileRegistry, skillsDir, storeDir, upsertEntry } from './registry.js'

/** 允许访问的主机（https only）。任何其它主机一律拒绝，避免把安装端点变成 SSRF 跳板。 */
const ALLOWED_HOSTS = new Set([
  'api.github.com',
  'raw.githubusercontent.com',
  'data.jsdelivr.com',
  'cdn.jsdelivr.net',
])
const REPO_RE = /^[\w.-]+\/[\w.-]+$/
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const REF_RE = /^[\w./-]{1,100}$/
const DIR_RE = /^[\w./-]+$/
const MAX_FILES = 80
const MAX_FILE_BYTES = 512 * 1024
const MAX_TOTAL_BYTES = 4 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 20_000
const TOTAL_BUDGET_MS = 150_000
const FETCH_CONCURRENCY = 4
const GH_HEADERS = { 'user-agent': 'qgm-air-runner', 'accept': 'application/vnd.github+json' }

/** 归一化后的安装规格（全部字段已通过正则校验） */
export interface NormalizedSpec {
  owner: string
  repo: string
  ref: string
  /** 仓库内技能目录，如 skills/pnpm */
  dir: string
  skill: string
  /** 忽略「本地已装」，重新安装（仍可命中本地库） */
  force: boolean
  /** 连本地库也忽略，强制重新下载 —— 三级短路全部跳过 */
  refresh: boolean
}

/** 规格解析结果（判别联合，避免返回半成品） */
export type SpecParse = { ok: true, spec: NormalizedSpec } | { ok: false, error: string, status: number }

/** 安装结果：AI 据此判成败，不再依赖 /run 的退出码 */
export interface InstallResult {
  ok: boolean
  status: 'already-installed' | 'from-store' | 'downloaded' | 'failed'
  skill: string
  source: string
  /** 真实发出的远端请求数（0 = 全程本地，判「是否真的联网」的唯一依据） */
  network: number
  /** 落到技能目录的相对文件列表 */
  files: string[]
  /** 本地库相对路径（离线重装用） */
  store: string
  /** 远端枚举通道（仅 downloaded 时有） */
  via?: 'github' | 'jsdelivr'
  registry?: { added: string[], removed: string[], total: number }
  hint?: string
  error?: string
}

/**
 * 校验并归一化安装规格。
 * [CONSTRAINT] 缺字段/越界一律 400 + 可读原因；不做「默认值兜底」（那会把错误输入静默放行）。
 */
export function parseInstallSpec(body: unknown): SpecParse {
  const b = (body && typeof body === 'object') ? body as Record<string, unknown> : {}
  const source = typeof b.source === 'string' ? b.source.trim() : ''
  const skill = typeof b.skill === 'string' ? b.skill.trim() : ''
  if (!source) return { ok: false, error: '缺少 source（形如 owner/repo）', status: 400 }
  if (!REPO_RE.test(source)) return { ok: false, error: `source 非法：${source}（应为 owner/repo）`, status: 400 }
  if (!skill) return { ok: false, error: '缺少 skill（技能名，kebab-case）', status: 400 }
  if (!SKILL_NAME_RE.test(skill)) return { ok: false, error: `skill 非法：${skill}（只允许小写字母/数字/连字符，且不以连字符开头）`, status: 400 }
  const ref = typeof b.ref === 'string' && b.ref.trim() ? b.ref.trim() : 'HEAD'
  if (!REF_RE.test(ref) || ref.includes('..')) return { ok: false, error: `ref 非法：${ref}`, status: 400 }
  const rawPath = typeof b.path === 'string' && b.path.trim() ? b.path.trim() : `skills/${skill}`
  const dir = rawPath.replace(/^\/+|\/+$/g, '')
  if (!DIR_RE.test(dir) || dir.split('/').some(s => s === '' || s === '.' || s === '..')) {
    return { ok: false, error: `path 非法：${rawPath}`, status: 400 }
  }
  const [owner, repo] = source.split('/')
  return { ok: true, spec: { owner, repo, ref, dir, skill, force: b.force === true, refresh: b.refresh === true } }
}

/** 技能目录判定：目录存在且含 SKILL.md。与 registry.listInstalledNames 同一判据，避免两处漂移 */
function isSkillDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, 'SKILL.md'))
  } catch { return false }
}

/** 拼接并校验不越界（防 ../../ 穿越） */
function safeJoin(base: string, rel: string): string {
  const rootAbs = path.resolve(base)
  const abs = path.resolve(rootAbs, rel)
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) throw new Error(`路径越界：${rel}`)
  return abs
}

/** 递归复制目录，返回写入的相对文件列表 */
function copyTree(src: string, dest: string): string[] {
  const out: string[] = []
  const walk = (rel: string): void => {
    const from = rel ? path.join(src, rel) : src
    for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
      const child = rel ? `${rel}/${ent.name}` : ent.name
      if (ent.isDirectory()) { walk(child); continue }
      if (!ent.isFile()) continue
      const to = safeJoin(dest, child)
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.copyFileSync(rel ? path.join(src, rel, ent.name) : path.join(src, ent.name), to)
      out.push(child)
    }
  }
  walk('')
  return out
}

/** 用给定内容覆盖目标目录（先清后写，避免残留旧文件） */
function writeTree(dest: string, files: Map<string, string>): string[] {
  rmTree(dest)
  const out: string[] = []
  for (const [rel, text] of files) {
    const to = safeJoin(dest, rel)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.writeFileSync(to, text)
    out.push(rel)
  }
  return out
}

/** 删除目录（仅用于本模块自建的、名字已正则校验过的路径） */
function rmTree(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

/** 落一份来源说明，供 registry 收敛（inferSource）与离线重装追溯 */
function writeSourceNote(store: string, spec: NormalizedSpec, via: string): void {
  const body = [
    '# 来源',
    '',
    `来源: ${spec.owner}/${spec.repo}`,
    `路径: ${spec.dir}`,
    `ref: ${spec.ref}`,
    `获取通道: ${via}`,
    `安装时间: ${new Date().toISOString()}`,
    '',
    '本文件由 `POST /__ai/skills/install` 自动生成，供 registry 来源收敛与离线重装使用。',
    '',
  ].join('\n')
  fs.writeFileSync(safeJoin(store, 'SOURCE.md'), body)
}

function assertAllowedHost(url: string): void {
  const u = new URL(url)
  if (u.protocol !== 'https:') throw new Error(`拒绝非 https：${url}`)
  if (!ALLOWED_HOSTS.has(u.hostname)) throw new Error(`主机不在白名单：${u.hostname}`)
}

/** 带超时的文本抓取；每次调用都计入 network 计数（判「是否真的联网」的依据） */
async function fetchText(url: string, counter: { n: number }, timeoutMs: number, cap = MAX_FILE_BYTES): Promise<string> {
  assertAllowedHost(url)
  counter.n += 1
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers: GH_HEADERS, signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    const bytes = Buffer.byteLength(text)
    if (bytes > cap) throw new Error(`响应超过上限 ${cap} 字节（${bytes}）`)
    return text
  } finally {
    clearTimeout(timer)
  }
}

/** 分批并发映射：既避开「串行 21 次必然超时」，也不至于把配额/连接数打爆；顺序与输入一致 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  const step = Math.max(1, limit)
  for (let i = 0; i < items.length; i += step) {
    const done = await Promise.all(items.slice(i, i + step).map(item => fn(item)))
    out.push(...done)
  }
  return out
}

function remainMs(deadline: number): number {
  return Math.max(1_000, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()))
}

/** 路径逐段编码（保留 / 分隔符） */
function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/')
}

/** 用 GitHub tree API 枚举 + raw 拉取 */
async function fetchViaGitHub(spec: NormalizedSpec, counter: { n: number }, deadline: number): Promise<{ files: Map<string, string>, via: 'github' }> {
  const treeUrl = `https://api.github.com/repos/${spec.owner}/${spec.repo}/git/trees/${spec.ref}?recursive=1`
  const tree = JSON.parse(await fetchText(treeUrl, counter, remainMs(deadline), MAX_TOTAL_BYTES)) as { tree?: Array<{ path?: string, type?: string, size?: number }> }
  const prefix = `${spec.dir}/`
  const blobs = (tree.tree ?? []).filter(t => t && t.type === 'blob' && typeof t.path === 'string' && t.path.startsWith(prefix))
  if (blobs.length === 0) throw new Error(`仓库 tree 内未找到 ${spec.dir}/（ref=${spec.ref}）`)
  if (blobs.length > MAX_FILES) throw new Error(`文件数 ${blobs.length} 超过上限 ${MAX_FILES}`)
  const totalBytes = blobs.reduce((sum, t) => sum + (Number(t.size) || 0), 0)
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`总体积 ${totalBytes} 超过上限 ${MAX_TOTAL_BYTES}`)
  const fullPaths = blobs.map(t => String(t.path))
  const texts = await mapLimit(fullPaths, FETCH_CONCURRENCY, p =>
    fetchText(`https://raw.githubusercontent.com/${spec.owner}/${spec.repo}/${spec.ref}/${encodePath(p)}`, counter, remainMs(deadline)))
  const files = new Map<string, string>()
  fullPaths.forEach((p, i) => files.set(p.slice(prefix.length), texts[i]))
  return { files, via: 'github' }
}

/** GitHub API 不可用时的降级通道（jsDelivr 数据接口枚举 + CDN 取内容） */
async function fetchViaJsdelivr(spec: NormalizedSpec, counter: { n: number }, deadline: number): Promise<{ files: Map<string, string>, via: 'jsdelivr' }> {
  // jsDelivr 的 gh 包按「分支/标签」解析，HEAD 不是合法 ref → 只在降级路径上做候选枚举
  const refs = spec.ref === 'HEAD' ? ['latest', 'main', 'master'] : [spec.ref]
  let lastErr = ''
  for (const ref of refs) {
    try {
      const metaUrl = `https://data.jsdelivr.com/v1/packages/gh/${spec.owner}/${spec.repo}@${ref}?structure=flat`
      const meta = JSON.parse(await fetchText(metaUrl, counter, remainMs(deadline), MAX_TOTAL_BYTES)) as { files?: Array<{ name?: string, size?: number }> }
      const prefix = `/${spec.dir}/`
      const entries = (meta.files ?? []).filter(f => typeof f.name === 'string' && f.name.startsWith(prefix))
      if (entries.length === 0) throw new Error(`jsDelivr 未找到 ${spec.dir}/`)
      if (entries.length > MAX_FILES) throw new Error(`文件数 ${entries.length} 超过上限 ${MAX_FILES}`)
      const totalBytes = entries.reduce((sum, f) => sum + (Number(f.size) || 0), 0)
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`总体积 ${totalBytes} 超过上限 ${MAX_TOTAL_BYTES}`)
      const fullPaths = entries.map(f => String(f.name).replace(/^\//, ''))
      const texts = await mapLimit(fullPaths, FETCH_CONCURRENCY, p =>
        fetchText(`https://cdn.jsdelivr.net/gh/${spec.owner}/${spec.repo}@${ref}/${encodePath(p)}`, counter, remainMs(deadline)))
      const files = new Map<string, string>()
      fullPaths.forEach((p, i) => files.set(p.slice(spec.dir.length + 1), texts[i]))
      return { files, via: 'jsdelivr' }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
    }
  }
  throw new Error(lastErr || 'jsDelivr 获取失败')
}

/** 双通道取远端技能文件 */
async function fetchSkillFiles(spec: NormalizedSpec, counter: { n: number }): Promise<{ files: Map<string, string>, via: 'github' | 'jsdelivr' }> {
  const deadline = Date.now() + TOTAL_BUDGET_MS
  let primaryErr = ''
  try {
    return await fetchViaGitHub(spec, counter, deadline)
  } catch (e) {
    primaryErr = e instanceof Error ? e.message : String(e)
  }
  try {
    return await fetchViaJsdelivr(spec, counter, deadline)
  } catch (e) {
    throw new Error(`远端获取失败 —— github: ${primaryErr}；jsdelivr: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * 本地优先安装（顺序即策略，调用方无需先查任何表）。
 * [CONSTRAINT] 永不抛错：一切失败转成 `{ ok:false, status:'failed', error }`，让调用方能读到 network 计数。
 */
export async function installSkill(root: string, spec: NormalizedSpec): Promise<InstallResult> {
  const counter = { n: 0 }
  const sourceLabel = `${spec.owner}/${spec.repo}`
  const target = path.join(skillsDir(root), spec.skill)
  const store = path.join(storeDir(root), spec.owner, spec.repo, spec.skill)
  const base = {
    skill: spec.skill,
    source: sourceLabel,
    store: path.relative(root, store).split(path.sep).join('/'),
  }

  try {
    // ── 第一层：本地已装（0 网络）────────────────────────────────────
    if (!spec.force && !spec.refresh && isSkillDir(target)) {
      return {
        ...base,
        ok: true,
        status: 'already-installed',
        network: 0,
        files: [],
        registry: reconcileRegistry(root, listInstalledNames(root)),
        hint: '本地已装，未发起任何网络请求。确需覆盖请传 force:true（重新安装）或 refresh:true（强制重新下载）',
      }
    }
    // ── 第二层：本地库命中（0 网络）──────────────────────────────────
    if (!spec.refresh && isSkillDir(store)) {
      rmTree(target)
      const files = copyTree(store, target)
      return {
        ...base,
        ok: true,
        status: 'from-store',
        network: 0,
        files,
        registry: reconcileRegistry(root, listInstalledNames(root)),
        hint: '命中本地库，未发起任何网络请求',
      }
    }
    // ── 第三层：远端下载（唯一联网的路径）──────────────────────────
    const outcome = await fetchSkillFiles(spec, counter)
    const skillMd = outcome.files.get('SKILL.md')
    if (!skillMd) throw new Error('远端目录内没有 SKILL.md')
    const meta = parseFrontmatter(skillMd)
    if (!meta) throw new Error('远端 SKILL.md 的 frontmatter 缺失或不可解析（name 与 description 均为必需）')
    writeTree(store, outcome.files)
    writeSourceNote(store, spec, outcome.via)
    rmTree(target)
    const files = copyTree(store, target)
    upsertEntry(root, {
      name: spec.skill,
      source: sourceLabel,
      url: `https://github.com/${sourceLabel}/blob/${spec.ref}/${spec.dir}/SKILL.md`,
    })
    return {
      ...base,
      ok: true,
      status: 'downloaded',
      network: counter.n,
      files,
      via: outcome.via,
      registry: reconcileRegistry(root, listInstalledNames(root)),
      hint: '安装完成。请用 GET /__ai/skills 自检（不要用 exit code 判成败）',
    }
  } catch (e) {
    return {
      ...base,
      ok: false,
      status: 'failed',
      network: counter.n,
      files: [],
      error: e instanceof Error ? e.message : String(e),
    }
  }
}
