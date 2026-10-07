#!/usr/bin/env node
// @desc: 文档索引对账——docs/DOCS-INDEX.md 里每个本地链接必须存在，仓库里每个项目 md 也必须在索引里
// @why: 旧索引声称收录 39 个文档，实际 docs/ 只有 4 个，且列出的一批 docs/plan/**、PROJECT-NOTES.md 全不存在；
//   索引腐化没有代价时必然腐化，故把它变成可执行断言。
// @plan: verify-docs-index
// [docs-index-contract-v1] 双向校验：dangling link（索引 → 磁盘）与 unlisted doc（磁盘 → 索引）都要报
// [docs-scan-shared-v1] 扫描范围/跳过表/链接抽取统一走 scripts/lib/docs-scan.cjs（同源口径，见 WO-20261007-10 段二）。
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { collectDocs, extractLinks } = require('./lib/docs-scan.cjs')

const ROOT = path.resolve(__dirname, '..')
const INDEX = path.join(ROOT, 'docs', 'DOCS-INDEX.md')
const NL = String.fromCharCode(10)

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
