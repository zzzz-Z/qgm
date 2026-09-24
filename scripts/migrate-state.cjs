#!/usr/bin/env node
// [migrate-state-v1] PLAN 7.D5 state.json 迁移：旧字段保留，新字段追加，幂等
// 用法: node scripts/migrate-state.cjs [--dry-run] [--backup] [--target <ver>]

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const STATE = path.join(ROOT, '.ai-runner/state.json')
const TARGET_VERSION = 12

function parseArgs(argv) {
  const o = { dryRun: false, backup: true, target: TARGET_VERSION }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') o.dryRun = true
    else if (a === '--no-backup') o.backup = false
    else if (a === '--target') o.target = Number(argv[++i]) || TARGET_VERSION
  }
  return o
}

// 迁移规则：每条 { from, to, apply(st) }。已升级到 target 则跳过。
const MIGRATIONS = [
  {
    from: 11,
    to: 12,
    desc: 'v11→v12: 补 pipeline / timeline / checkpoint 字段占位，兼容旧字段',
    apply(st) {
      if (!st.pipeline || typeof st.pipeline !== 'object') st.pipeline = {}
      if (!Array.isArray(st.checkpoints)) st.checkpoints = []
      if (st.finishedAt === undefined) st.finishedAt = null
      if (typeof st.doneCount !== 'number') st.doneCount = Array.isArray(st.done) ? st.done.length : 0
      if (typeof st.totalCount !== 'number') {
        const t = Array.isArray(st.todo) ? st.todo.length : 0
        const d = Array.isArray(st.done) ? st.done.length : 0
        st.totalCount = t + d
      }
      if (typeof st.stallCounter !== 'number') st.stallCounter = 0
      if (typeof st.consecutiveFailures !== 'number') st.consecutiveFailures = 0
      if (st.pendingInput === undefined) st.pendingInput = null
      return st
    },
  },
  {
    from: 12,
    to: 13,
    // [migrate-v13] v12→v13：补 pipeline/updatedAt 字段
    desc: 'v12→v13: 补 pipeline 占位（run.ts 已写入，但旧 state 需迁移）',
    apply(st) {
      if (!st.pipeline || typeof st.pipeline !== 'object') st.pipeline = {}
      if (typeof st.updatedAt !== 'string') st.updatedAt = new Date().toISOString()
      return st
    },
  },
]

function run() {
  const args = parseArgs(process.argv)
  if (!fs.existsSync(STATE)) { console.error('state.json 不存在'); process.exit(2) }
  const raw = fs.readFileSync(STATE, 'utf8')
  const st = JSON.parse(raw)
  const cur = Number(st.version || 0)
  console.log(`current version=${cur} target=${args.target}`)
  if (cur >= args.target) { console.log('✓ 已是最新，无需迁移'); process.exit(0) }
  const applicable = MIGRATIONS.filter(m => m.from >= cur && m.to <= args.target).sort((a, b) => a.from - b.from)
  if (!applicable.length) { console.log('! 无匹配迁移规则'); process.exit(0) }
  let next = JSON.parse(JSON.stringify(st))
  for (const m of applicable) {
    console.log(`  apply ${m.from}→${m.to}: ${m.desc}`)
    next = m.apply(next)
    next.version = m.to
  }
  if (args.dryRun) {
    console.log('--- dry-run 结果（未落盘）---')
    console.log(`${JSON.stringify(next, null, 2).slice(0, 600)}...`)
    process.exit(0)
  }
  if (args.backup) {
    const bak = `${STATE}.bak-${Date.now()}`
    fs.writeFileSync(bak, raw, 'utf8')
    console.log(`✓ 备份 → ${bak}`)
  }
  fs.writeFileSync(STATE, JSON.stringify(next, null, 2), 'utf8')
  console.log(`✓ 迁移完成 → version=${next.version}`)
}

run()
