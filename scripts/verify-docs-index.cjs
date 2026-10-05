#!/usr/bin/env node
// @desc: 文档索引对账——docs/DOCS-INDEX.md 里每个本地链接必须存在，仓库里每个项目 md 也必须在索引里
// @why: 旧索引声称收录 39 个文档，实际 docs/ 只有 4 个，且列出的一批 docs/plan/**、PROJECT-NOTES.md 全不存在；
//   索引腐化没有代价时必然腐化，故把它变成可执行断言。
// @plan: verify-docs-index
// [docs-index-contract-v1] 双向校验：dangling link（索引 → 磁盘）与 unlisted doc（磁盘 → 索引）都要报
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const INDEX = path.join(ROOT, 'docs', 'DOCS-INDEX.md')
// 非项目文档：运行态 / 依赖 / 产物 / 会话工作记忆
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.ai-runner', '.workbuddy', '.trae', '.vscode', 'coverage'])
// [docs-index-testartifacts-v1] Playwright 生成物：error-context.md 等只在用例失败时写出，
// 属运行态而非项目文档；不排除则「跑一次红 e2e → docs:verify 恒 exit 2」（2026-10-05 实测）。
SKIP_DIRS.add('test-results')
SKIP_DIRS.add('playwright-report')
// [docs-index-generated-v1] 生成物文档目录（相对根）：docs/plan/** 由 verify-contracts.cjs 每次运行时写出，
// 不属人工维护文档 → 不纳入索引义务，否则「跑完 verify:contracts 再跑 docs:verify」必 exit 2。
// SKIP_DIRS 只按目录名匹配，表达不了这种具体路径，故单列前缀表。
const SKIP_PATHS = [path.join('docs', 'plan')]
const NL = String.fromCharCode(10)

/** 收集仓库内所有项目 md（相对仓库根） */
function collectDocs(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue
    const p = path.join(dir, e.name)
    const rel = path.relative(ROOT, p)
    if (SKIP_PATHS.some(pre => rel === pre || rel.startsWith(pre + path.sep))) continue
    if (e.isDirectory()) collectDocs(p, out)
    else if (path.extname(p) === '.md') out.push(rel)
  }
  return out
}

/** 抽出索引里所有本地 md 链接（跳过 http/https/mailto/纯锚点） */
function extractLinks(text) {
  const out = []
  const re = /\]\(([^)\s]+)\)/g
  let m
  while ((m = re.exec(text)) !== null) {
    const target = m[1]
    if (/^(?:https?:|mailto:|#)/.test(target)) continue
    out.push(target.split('#')[0])
  }
  return out
}

function main() {
  if (!fs.existsSync(INDEX)) {
    console.error('✗ docs/DOCS-INDEX.md 不存在')
    process.exit(2)
  }
  const text = fs.readFileSync(INDEX, 'utf8')

  // ① 索引 → 磁盘：链接不得悬空
  const dangling = []
  for (const link of new Set(extractLinks(text))) {
    if (!fs.existsSync(path.resolve(path.dirname(INDEX), link))) dangling.push(link)
  }

  // ② 磁盘 → 索引：每个项目 md 都要被索引提到（正文提到路径即可，不要求写成链接）
  const unlisted = []
  for (const doc of collectDocs(ROOT)) {
    const base = path.basename(doc)
    if (!text.includes(doc) && !text.includes(base)) unlisted.push(doc)
  }

  if (dangling.length || unlisted.length) {
    console.error(`✗ 文档索引对账失败`)
    if (dangling.length) {
      console.error(`  -- 悬空链接 (${dangling.length})：索引指向的文档不存在 --`)
      dangling.forEach(d => console.error(`  ${d}`))
    }
    if (unlisted.length) {
      console.error(`  -- 未收录 (${unlisted.length})：磁盘上存在但索引没提 --`)
      unlisted.forEach(d => console.error(`  ${d}`))
    }
    console.error(`${NL}修复：改 docs/DOCS-INDEX.md，或补/删对应文档后同步索引。`)
    process.exit(2)
  }
  console.log(`✓ 文档索引对账通过 (${collectDocs(ROOT).length} 个项目文档，无悬空链接、无漏收录)`)
}

main()
