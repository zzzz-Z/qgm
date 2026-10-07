'use strict'
// [docs-scan-v1] 文档扫描同源口径：供 verify-docs-index.cjs 与 verify-crossfile.cjs 共用。
// [WHY] 两份副本必然各自漂移（项目铁律）——扫描范围、跳过表、链接抽取必须单源。
// [CONSTRAINT] 纯 node:fs / node:path，零新依赖；root 由调用方注入（不依赖 __dirname）。
const fs = require('node:fs')
const path = require('node:path')

// 非项目文档：运行态 / 依赖 / 产物 / 会话工作记忆
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.ai-runner', '.workbuddy', '.trae', '.vscode', 'coverage'])
// [docs-index-testartifacts-v1] Playwright 生成物只在用例失败时写出，属运行态
SKIP_DIRS.add('test-results')
SKIP_DIRS.add('playwright-report')
// [docs-index-generated-v1] docs/plan/** 由 verify-contracts.cjs 每次写出，不属人工维护
const SKIP_PATHS = [path.join('docs', 'plan')]

/** 收集 root 下所有项目 md（返回相对 root 的 posix 路径） */
function collectDocs(root, dir = root, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue
    const p = path.join(dir, e.name)
    const rel = path.relative(root, p).split(path.sep).join('/')
    if (SKIP_PATHS.some(pre => rel === pre || rel.startsWith(`${pre}/`))) continue
    if (e.isDirectory()) collectDocs(root, p, out)
    else if (path.extname(p) === '.md') out.push(rel)
  }
  return out
}

/** 抽出 markdown 行内链接目标（跳过 http/https/mailto/纯锚点/javascript:/data:） */
function extractLinks(text) {
  const out = []
  const re = /\]\(([^)\s]+)\)/g
  let m
  while ((m = re.exec(text)) !== null) {
    const target = m[1]
    if (/^(?:https?:|mailto:|#|javascript:|data:)/.test(target)) continue
    out.push(target.split('#')[0])
  }
  return out
}

module.exports = { collectDocs, SKIP_DIRS, SKIP_PATHS, extractLinks }
