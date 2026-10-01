#! /usr/bin/env node
// @desc 把指定路径的变更自动存档到备份分支（默认 ai-archive），不动 HEAD / 工作区 / 真实索引
// @why 批量改文件时 git 层没有自动兜底；本脚本用临时索引把变更做成 commit 挂到备份分支，
//      既不打断当前分支，误删后也能随时 `git checkout ai-archive -- <path>` 找回内容。
// [CONSTRAINT] 必须显式 --path 或 AI_ARCHIVE_PATHS；watch 命中即存档，无路径则拒绝启动
// [CHANGE-IMPACT] 仅写 .git/refs/heads/<branch> 与 .ai-runner/tmp 临时索引；不触碰工作区

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DEFAULT_BRANCH = 'ai-archive'
const DEFAULT_DEBOUNCE_MS = 1500
const TMP_INDEX = path.join(ROOT, '.ai-runner', 'tmp', 'git-archive-index')
/** watch 时忽略的路径段：运行态与产物变更不应触发存档 */
const IGNORE_SEGMENTS = new Set(['node_modules', '.git', 'dist', '.ai-runner'])

/**
 * 解析 CLI 参数，并合并 AI_ARCHIVE_PATHS 环境变量（逗号分隔）
 * @param {string[]} argv 去掉 node 与脚本名后的参数
 */
function parseArgs(argv) {
  const opts = { paths: [], branch: DEFAULT_BRANCH, debounce: DEFAULT_DEBOUNCE_MS, watch: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--watch') opts.watch = true
    else if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--path') opts.paths.push(String(argv[++i] || ''))
    else if (a === '--branch') opts.branch = String(argv[++i] || '') || DEFAULT_BRANCH
    else if (a === '--debounce') opts.debounce = Number(argv[++i]) || DEFAULT_DEBOUNCE_MS
  }
  const fromEnv = String(process.env.AI_ARCHIVE_PATHS || '').split(',')
  opts.paths = [...new Set([...opts.paths, ...fromEnv].map(s => s.trim()).filter(Boolean))]
  return opts
}

/**
 * 执行 git 命令；index 传入时走临时索引（GIT_INDEX_FILE），失败抛错
 * [CONSTRAINT] 统一注入 GIT_PAGER=cat / GIT_TERMINAL_PROMPT=0，避免分页与认证交互卡住
 * @param {string[]} args git 子命令与参数
 * @param {string} [index] 临时索引绝对路径；省略则用仓库真实索引
 */
function git(args, index) {
  const env = { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' }
  if (index) env.GIT_INDEX_FILE = index
  return execFileSync('git', args, { cwd: ROOT, env, encoding: 'utf8' }).trim()
}

/** 执行 git 但不抛错；返回 { ok, out }，out 为 stdout 或错误摘要 */
function gitTry(args, index) {
  try {
    return { ok: true, out: git(args, index) }
  } catch (e) {
    return { ok: false, out: String((e && e.stderr) || (e && e.message) || e).trim() }
  }
}

/**
 * 统计 parent→tree 的逐文件差异（A/M/D 与增删行数）
 * [WHY] commit message 必须准确，故按真实 diff 而非脚本声明生成
 * @returns {Map<string, { status: string, added: number, removed: number }>}
 */
function collectStats(parent, tree) {
  const map = new Map()
  for (const line of git(['diff', '--numstat', parent, tree]).split('\n')) {
    const c = line.split('\t')
    if (c.length < 3) continue
    map.set(c[2], { status: 'modified', added: Number(c[0]) || 0, removed: Number(c[1]) || 0 })
  }
  for (const line of git(['diff', '--name-status', parent, tree]).split('\n')) {
    const c = line.split('\t')
    if (c.length < 2) continue
    const flag = c[0].charAt(0)
    const status = flag === 'A' ? 'added' : flag === 'D' ? 'deleted' : flag === 'R' ? 'renamed' : 'modified'
    const prev = map.get(c[c.length - 1]) || { added: 0, removed: 0 }
    map.set(c[c.length - 1], { ...prev, status })
  }
  return map
}

/** 拼装 commit message：文件数 + 逐文件 A/M/D 与增删行 + 源分支 + 时间戳 */
function buildMessage(parent, tree, branch) {
  const stats = [...collectStats(parent, tree).entries()].sort((a, b) => a[0].localeCompare(b[0]))
  const src = gitTry(['rev-parse', '--abbrev-ref', 'HEAD']).out || 'unknown'
  const lines = stats.map(([file, s]) => {
    const tag = s.status === 'added' ? 'A' : s.status === 'deleted' ? 'D' : s.status === 'renamed' ? 'R' : 'M'
    return `- [${tag}] ${file}  +${s.added}/-${s.removed}`
  })
  const head = `chore(archive): 自动存档 ${stats.length} 个文件（源分支 ${src}）`
  const foot = `${branch} · ${new Date().toISOString()}`
  return [head, '', ...lines, '', foot].join('\n')
}

/**
 * 用临时索引把指定路径的当前内容做成 commit 挂到备份分支
 * [CONSTRAINT] 全程 GIT_INDEX_FILE 隔离，read-tree/add/write-tree/commit-tree 均不触碰真实索引与工作区
 * @returns {{ ok: boolean, changed?: number, commit?: string, files?: number, reason?: string }}
 */
function archive(opts) {
  const exists = opts.paths.filter(p => fs.existsSync(path.join(ROOT, p)))
  if (exists.length === 0) return { ok: false, reason: '指定路径均不存在' }
  if (!gitTry(['rev-parse', '--verify', 'HEAD']).ok) return { ok: false, reason: '当前仓库无 HEAD（空仓库）' }
  fs.mkdirSync(path.dirname(TMP_INDEX), { recursive: true })
  const branchRef = gitTry(['rev-parse', '--verify', `refs/heads/${opts.branch}`])
  const parent = branchRef.ok ? branchRef.out : git(['rev-parse', 'HEAD'])
  git(['read-tree', parent], TMP_INDEX)
  git(['add', '-A', '--', ...exists], TMP_INDEX)
  const tree = git(['write-tree'], TMP_INDEX)
  if (tree === git(['rev-parse', `${parent}^{tree}`])) return { ok: true, changed: 0 }
  const commit = git(['commit-tree', tree, '-p', parent, '-m', buildMessage(parent, tree, opts.branch)])
  git(['update-ref', `refs/heads/${opts.branch}`, commit])
  return { ok: true, changed: 1, commit: commit.slice(0, 12), files: exists.length }
}

/** 执行一次存档并打印结果 */
function runArchive(opts) {
  const r = archive(opts)
  if (!r.ok) console.log(`[git-archive] 跳过：${r.reason}`)
  else if (!r.changed) console.log('[git-archive] 无变更，跳过')
  else console.log(`[git-archive] 已存档 ${r.files} 个文件 -> ${opts.branch} (${r.commit})`)
}

/** 判断相对路径是否命中忽略段（node_modules / .git / dist / .ai-runner） */
function isIgnored(rel) {
  return rel.split(path.sep).some(seg => IGNORE_SEGMENTS.has(seg))
}

/**
 * watch 模式：监听各路径，防抖窗口内静默后自动存档一次
 * [CONSTRAINT] 存档不写工作区，不会自我触发；busy 守卫防重入
 * @returns {number} 实际监听的路径数
 */
function startWatch(opts) {
  let timer = null
  let busy = false
  const schedule = () => {
    if (busy) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      busy = true
      try { runArchive(opts) } finally { busy = false }
    }, opts.debounce)
  }
  let watched = 0
  for (const p of opts.paths) {
    const abs = path.join(ROOT, p)
    if (!fs.existsSync(abs)) { console.warn(`[git-archive] 跳过不存在路径：${p}`); continue }
    fs.watch(abs, { recursive: true }, (_evt, filename) => {
      if (filename && isIgnored(path.relative(ROOT, path.join(abs, String(filename))))) return
      schedule()
    })
    watched++
  }
  return watched
}

/** 打印用法 */
function printHelp() {
  console.log(`git-archive — 把指定路径的变更自动存档到备份分支（不动当前分支与工作区）

用法：
  node scripts/git-archive.mjs --path <p> [--path <p>] [--branch ai-archive]   # 存档一次
  node scripts/git-archive.mjs --watch --path <p> [--debounce 1500]            # 监听变更并自动存档

环境变量：
  AI_ARCHIVE_PATHS=packages/core,scripts   等价于多个 --path（逗号分隔）

npm 入口：
  pnpm git:archive -- --path packages/core
  pnpm git:archive:watch -- --path packages/core`)
}

/** 入口：校验路径 → 一次存档 或 监听存档 */
function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) { printHelp(); return }
  if (opts.paths.length === 0) {
    console.error('[git-archive] 必须指定路径：--path <p>（可重复）或 AI_ARCHIVE_PATHS=a,b')
    console.error('示例：pnpm git:archive:watch -- --path packages/core')
    process.exitCode = 2
    return
  }
  if (!opts.watch) { runArchive(opts); return }
  runArchive(opts)
  const n = startWatch(opts)
  if (n === 0) { console.error('[git-archive] 无可监听路径，退出'); process.exitCode = 2; return }
  console.log(`[git-archive] 监听 ${n} 个路径，变更后 ${opts.debounce}ms 自动存档到 ${opts.branch}（Ctrl+C 退出）`)
}

main()
