#!/usr/bin/env node
// 动态加载器：扫描多根目录下的所有 .md skill
// 支持 frontmatter: ---/name/description/---
// 无 frontmatter 时用相对路径（去 .md，/ 换 -）作为 key
// 支持 frontmatter 字段：name / description / keywords（逗号分隔，命中≥2 才注入）

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const NL = '\n'

const ROOT = path.dirname(__dirname)
const HOME = os.homedir()

// 搜索根目录（相对项目根），不存在则跳过
// 根目录：项目内 skills/ 全量递归；外部 skill 库只扫主 SKILL.md（不递归 references/ 等子目录）
const ROOTS = [
  { dir: path.join(ROOT, 'skills'), onlySkillFile: false },
  { dir: path.join(ROOT, '.agents/skills'), onlySkillFile: true },
  { dir: path.join(ROOT, '.claude/skills'), onlySkillFile: true },
  { dir: path.join(ROOT, '.cursor/skills'), onlySkillFile: true },
  { dir: path.join(HOME, '.agents/skills'), onlySkillFile: true },
  { dir: path.join(HOME, '.claude/skills'), onlySkillFile: true },
  { dir: path.join(HOME, '.cursor/skills'), onlySkillFile: true },
]

// 语义分组：key 匹配 rel 前缀或 key 前缀
const GROUPS = {
  core: ['core/', 'behavior', 'loop-protocol'],
  rules: ['core/behavior', 'env/preflight'],
  loop: ['loop-protocol'],
  script: ['script/'],
  env: ['env/'],
  ui: ['ui/'],
  refactor: ['refactor/'],

}

const KEYWORDS = {
  ui: ['css', 'style', '样式', '颜色', 'background', '选择器', 'important', 'flex', '布局', '边距'],
  vue: ['vue', 'defineProps', 'defineModel', 'computed', 'template', 'script setup', '组件'],
  script: ['脚本', 'cjs', 'node', 'bash', 'rollback', 'backup', 'ai-runner', '幂等'],
  env: ['环境', 'dev server', 'worktree', 'cwd', '分支', 'tsc', 'eslint'],
  loop: ['循环', 'loop', 'round', 'todo', 'state.json'],
  refactor: ['重构', '架构', '高内聚', '低耦合', 'hclc', 'typescript 架构', '依赖注入', '接口隔离'],
}

// 常驻元规则：每轮无条件注入（决策准则/脚本契约/脚本标准/环境自检）
// [system-md-migrated] RULES.md 已迁移到根 SYSTEM.md；该文件现由 useDeepseekUrl
// 的 _prependFirstPromptRules 在会话首问时拼入 prompt，不再走 skills loader。
// 保留数组但留空，未来如需追加常驻 skill 在此登记（key 需与 REGISTRY 一致）。
const ALWAYS_KEYS = []
function isDefault(key) { return ALWAYS_KEYS.includes(key) }

function parseFrontmatter(text) {
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*\n/.exec(text)
  if (!m) return { meta: {}, body: text }
  const meta = {}
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':')
    if (i < 0) continue
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return { meta, body: text.slice(m[0].length) }
}

function walk(dir, opts, depth) {
  const onlySkillFile = !!(opts && opts.onlySkillFile)
  const d = typeof depth === 'number' ? depth : 0
  const out = []
  let ents
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      // [archiveSkip] 归档目录不参与扫描
      if (e.name === '_archive') continue
      // [depthCap] onlySkillFile 模式下只下探到 skill 根目录下第一层，再深不再进
      if (onlySkillFile && d >= 1) continue
      out.push(...walk(p, opts, d + 1))
    } else if (e.name.endsWith('.md') && e.name !== 'INDEX.md') {
      if (onlySkillFile && e.name !== 'SKILL.md') continue
      out.push(p)
    }
  }
  return out
}

// [deriveKwFromDesc] 无 keywords 时从 description 派生：
//   - 反引号包裹的标识符
//   - 含点号的文件名 token
//   - 长度 >= 4 的英文词（去停用词）
const DESC_STOP = new Set([
  'the',
  'and',
  'for',
  'use',
  'with',
  'when',
  'are',
  'this',
  'that',
  'from',
  'into',
  'your',
  'you',
  'any',
  'all',
  'can',
  'has',
  'was',
  'will',
  'not',
  'but',
  'via',
  'off',
  'one',
  'two',
  'its',
  'our',
  'out',
  'per',
  'may',
  'also',
  'such',
  'like',
  'more',
  'less',
  'than',
  'each',
  'over',
  'only',
  'just',
  'have',
  'been',
  'were',
  'they',
  'them',
  'their',
  'there',
  'then',
  'does',
  'done',
  'must',
  'should',
  'would',
  'could',
  'about',
  'across',
  'between',
])

function deriveKwFromDesc(desc) {
  const s = String(desc || '')
  const out = new Set()
  for (const m of s.matchAll(/`([^`]+)`/g)) {
    const v = m[1].trim().toLowerCase()
    if (v && v.length <= 40) out.add(v)
  }
  for (const m of s.matchAll(/\b([\w-]+\.[\w.-]+)\b/g)) {
    out.add(m[1].toLowerCase())
  }
  for (const m of s.matchAll(/\b([A-Z][\w-]{3,})\b/gi)) {
    const v = m[1].toLowerCase()
    if (!DESC_STOP.has(v)) out.add(v)
  }
  return [...out].slice(0, 24)
}

const REGISTRY = new Map()

function scan() {
  REGISTRY.clear()
  for (const r of ROOTS) {
    const abs = r.dir
    if (!fs.existsSync(abs)) continue
    for (const p of walk(abs, { onlySkillFile: r.onlySkillFile })) {
      const rel = path.relative(abs, p).replace(/\\/g, '/')
      const text = fs.readFileSync(p, 'utf8')
      const { meta } = parseFrontmatter(text)
      let kw = meta.keywords ? String(meta.keywords).split(',').map(s => s.trim()).filter(Boolean) : []
      if (!kw.length) kw = deriveKwFromDesc(meta.description)
      // [nameAlwaysKw] name 永远算作关键词（解决短名如 vue 被长度阈值剔除）
      if (meta.name) {
        const nv = String(meta.name).trim().toLowerCase()
        if (nv && !kw.includes(nv)) kw = [nv, ...kw]
      }
      const key = rel.replace(/\.md$/, '').replace(/\//g, '-')
      REGISTRY.set(key, {
        key,
        name: meta.name || key,
        desc: meta.description || '',
        kw,
        file: p,
        rel: `${abs.startsWith(HOME) ? `~${abs.slice(HOME.length)}` : path.relative(ROOT, abs).replace(/\\/g, '/')}/${rel}`,
        text,
      })
    }
  }
  return REGISTRY
}

function list() { return [...REGISTRY.keys()].sort() }

function load(keys) {
  const names = Array.isArray(keys) ? keys : [keys]
  const picked = []
  for (const k of names) {
    if (GROUPS[k]) {
      for (const [, v] of REGISTRY) {
        if (GROUPS[k].some(pfx => v.rel.includes(`/${pfx}`) || v.key.startsWith(pfx))) picked.push(v)
      }
    } else if (REGISTRY.has(k)) { picked.push(REGISTRY.get(k))
    }
  }
  const seen = new Set()
  const uniq = picked.filter(v => seen.has(v.key) ? false : (seen.add(v.key), true))
  return uniq.map(v => `## [${v.rel}]${NL}${NL}${v.text}`).join(`${NL + NL}---${NL}${NL}`)
}

// 累积命中分数：ALWAYS_KEYS 基础分 1；任务相关命中额外加分
function addHit(hits, key, add) {
  if (!hits.has(key)) hits.set(key, 0)
  hits.set(key, hits.get(key) + add)
}

// 按分数降序；同分保持原 Map 插入顺序（稳定排序）
function sortedByScore(hits) {
  return [...hits.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0])
}

function loadFor(task) {
  const t = String(task || '').toLowerCase()
  const hits = new Map(ALWAYS_KEYS.map(k => [k, 1]))

  // 1. frontmatter keywords 打分：命中数 >= 1 即注入
  for (const [k, v] of REGISTRY) {
    const kws = Array.isArray(v.kw) ? v.kw : []
    if (!kws.length) continue
    const score = kws.filter((w) => {
      const s = String(w).toLowerCase()
      if (!s) return false
      if (/^[a-z0-9_.-]+$/.test(s)) {
        const esc = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        return new RegExp(`(^|[^a-z0-9_])${esc}([^a-z0-9_]|$)`, 'i').test(t)
      }
      return t.includes(s)
    }).length
    if (score >= 1) addHit(hits, k, 1 + score)
  }

  // 2. 兜底：无 keywords 的 skill 走硬编码 KEYWORDS 分组
  for (const [k, kws] of Object.entries(KEYWORDS)) {
    if (kws.some(kw => t.includes(kw.toLowerCase()))) addHit(hits, k, 2)
  }

  return load(sortedByScore(hits))
}

scan()

function loadForMeta(task) {
  const t = String(task || '').toLowerCase()
  const hits = new Map(ALWAYS_KEYS.map(k => [k, 1]))
  for (const [k, v] of REGISTRY) {
    const kws = Array.isArray(v.kw) ? v.kw : []
    if (!kws.length) continue
    const score = kws.filter((w) => {
      const s = String(w).toLowerCase()
      if (!s) return false
      if (/^[a-z0-9_.-]+$/.test(s)) {
        const esc = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        return new RegExp(`(^|[^a-z0-9_])${esc}([^a-z0-9_]|$)`, 'i').test(t)
      }
      return t.includes(s)
    }).length
    if (score >= 1) addHit(hits, k, 1 + score)
  }
  for (const [k, kws] of Object.entries(KEYWORDS)) {
    if (kws.some(kw => t.includes(kw.toLowerCase()))) addHit(hits, k, 2)
  }
  const keys = sortedByScore(hits)
  return { content: load(keys), keys }
}

// [tier2a-1] 加载埋点：fail-silent，落 .ai-runner/skill-stats.json
function _recordSkillLoad(keys) {
  try {
    const _fs = require('node:fs')
    const _path = require('node:path')
    const _root = process.env.AI_RUNNER_ROOT || process.env.AIR_ROOT || process.cwd()
    const _p = _path.join(_root, '.ai-runner', 'skill-stats.json')
    let _s = { loads: {}, lastUpdate: 0 }
    try { _s = JSON.parse(_fs.readFileSync(_p, 'utf8')) } catch {}
    if (!_s || typeof _s !== 'object') _s = { loads: {}, lastUpdate: 0 }
    if (!_s.loads || typeof _s.loads !== 'object') _s.loads = {}
    const _arr = Array.isArray(keys) ? keys : []
    for (const k of _arr) _s.loads[k] = (_s.loads[k] || 0) + 1
    _s.lastUpdate = Date.now()
    _fs.writeFileSync(_p, JSON.stringify(_s, null, 2))
  } catch {}
}
const _loadOrig = load

module.exports = {
  load(keys) { try { _recordSkillLoad(keys) } catch {} return _loadOrig(keys) },
  loadFor,
  loadForMeta,
  list,
  scan,
  REGISTRY,
  GROUPS,
  KEYWORDS,
  ROOTS,
  ALWAYS_KEYS,
  isDefault,
}

if (require.main === module) {
  const a = process.argv[2]
  if (!a || a === '--list') {
    const active = ROOTS.filter(r => fs.existsSync(r.dir))
    console.log(`根目录: ${active.map(r => r.dir).join(', ')}`)
    console.log(`发现 ${REGISTRY.size} 个 skill:`)
    for (const k of list()) {
      const v = REGISTRY.get(k)
      console.log(`  ${k.padEnd(30)}${v.rel}${v.desc ? `  — ${v.desc}` : ''}`)
    }
    console.log('')
    console.log(`语义分组: ${Object.keys(GROUPS).join(', ')}`)
    process.exit(0)
  }
  if (a === '--for') { console.log(loadFor(process.argv.slice(3).join(' '))); process.exit(0) }
  // [dump-keywords-v1] 阶段1：把可匹配词按分组显式列出
  if (a === '--dump-keywords') {
    console.log('=== GROUPS 语义分组 → 匹配前缀 ===')
    for (const [g, pfx] of Object.entries(GROUPS)) {
      console.log(`  ${g.padEnd(12)}-> ${pfx.join(', ')}`)
    }
    console.log('')
    console.log('=== KEYWORDS 兜底词表 → 命中词 ===')
    for (const [g, kws] of Object.entries(KEYWORDS)) {
      console.log(`  ${g.padEnd(12)}<- ${kws.join(' / ')}`)
    }
    console.log('')
    console.log('=== REGISTRY 已注册 skill → keywords ===')
    for (const [k, v] of REGISTRY) {
      const kw = Array.isArray(v.kw) ? v.kw.join(',') : ''
      console.log(`  ${k.padEnd(28)}<- ${kw.slice(0, 120)}`)
    }
    process.exit(0)
  }
  if (a === '--reload') { scan(); console.log(`✓ 重扫 ${REGISTRY.size} 个`); process.exit(0) }
  console.log(load(a))
}
