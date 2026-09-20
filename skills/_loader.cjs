#!/usr/bin/env node
// 动态加载器：扫描多根目录下的所有 .md skill
// 支持 frontmatter: ---/name/description/---
// 无 frontmatter 时用相对路径（去 .md，/ 换 -）作为 key

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const NL = '\n'

const ROOT = path.dirname(__dirname)
const HOME = os.homedir()

// 搜索根目录（相对项目根），不存在则跳过
const ROOTS = [
  path.join(ROOT, 'skills'),
  path.join(ROOT, '.agents/skills'),
  path.join(ROOT, '.claude/skills'),
  path.join(ROOT, '.cursor/skills'),
  path.join(HOME, '.agents/skills'),
  path.join(HOME, '.claude/skills'),
  path.join(HOME, '.cursor/skills'),
]

// 语义分组：key 匹配 rel 前缀或 key 前缀
const GROUPS = {
  core: ['core/', 'behavior', 'loop-protocol', 'gen-rules'],
  rules: ['core/behavior', 'core/gen-rules', 'env/preflight'],
  loop: ['loop-protocol'],
  script: ['script/', 'gen-rules'],
  env: ['env/'],
  ui: ['ui/'],
  session: ['sessions/'],
}

const KEYWORDS = {
  ui: ['css', 'style', '样式', '颜色', 'background', '选择器', 'important', 'flex', '布局', '边距'],
  vue: ['vue', 'defineProps', 'defineModel', 'computed', 'template', 'script setup', '组件'],
  script: ['脚本', 'cjs', 'node', 'bash', 'rollback', 'backup', 'ai-runner', '幂等'],
  env: ['环境', 'dev server', 'worktree', 'cwd', '分支', 'tsc', 'eslint'],
  loop: ['循环', 'loop', 'round', 'todo', 'state.json'],
}

// 常驻元规则：每轮无条件注入（决策准则/脚本契约/脚本标准/环境自检）
const ALWAYS_KEYS = ['core-behavior', 'core-gen-rules', 'script-standards', 'env-preflight']
function isDefault(key) { return ALWAYS_KEYS.includes(key) }

function parseFrontmatter(text) {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n/.exec(text)
  if (!m) return { meta: {}, body: text }
  const meta = {}
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':')
    if (i < 0) continue
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return { meta, body: text.slice(m[0].length) }
}

function walk(dir) {
  const out = []
  let ents
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.name.endsWith('.md') && e.name !== 'INDEX.md') out.push(p)
  }
  return out
}

const REGISTRY = new Map()

function scan() {
  REGISTRY.clear()
  for (const abs of ROOTS) {
    if (!fs.existsSync(abs)) continue
    for (const p of walk(abs)) {
      const rel = path.relative(abs, p).replace(/\\/g, '/')
      const text = fs.readFileSync(p, 'utf8')
      const { meta } = parseFrontmatter(text)
      const key = rel.replace(/\.md$/, '').replace(/\//g, '-')
      REGISTRY.set(key, {
        key,
        name: meta.name || key,
        desc: meta.description || '',
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

function loadFor(task) {
  const t = String(task || '').toLowerCase()
  const hits = new Set(ALWAYS_KEYS)
  for (const [k, kws] of Object.entries(KEYWORDS)) {
    if (kws.some(kw => t.includes(kw.toLowerCase()))) hits.add(k)
  }
  return load([...hits])
}

scan()

module.exports = { load, loadFor, list, scan, REGISTRY, GROUPS, KEYWORDS, ROOTS, ALWAYS_KEYS, isDefault }

if (require.main === module) {
  const a = process.argv[2]
  if (!a || a === '--list') {
    const active = ROOTS.filter(r => fs.existsSync(r))
    console.log(`根目录: ${active.join(', ')}`)
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
  if (a === '--reload') { scan(); console.log(`✓ 重扫 ${REGISTRY.size} 个`); process.exit(0) }
  console.log(load(a))
}
