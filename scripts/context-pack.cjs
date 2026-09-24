#!/usr/bin/env node
// [context-pack-v1] PLAN 阶段4 上下文包装配器
// 用法: node scripts/context-pack.cjs <intent.json> [--budget 8000] [--out <file>] [--self-test]

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = process.cwd()
const MAPPING = path.join(ROOT, 'skills/mapping.json')
const LOADER = path.join(ROOT, 'skills/_loader.cjs')

function parseArgs(argv) {
  const out = { input: null, budget: 8000, outFile: null, selfTest: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--budget') out.budget = Number(argv[++i]) || 8000
    else if (a === '--out') out.outFile = argv[++i]
    else if (a === '--self-test') out.selfTest = true
    else if (!a.startsWith('--')) out.input = a
  }
  return out
}

function estimateTokens(s) { return Math.ceil(String(s).length / 3) }

function validateIntent(j) {
  const errs = []
  if (!j || typeof j !== 'object') return ['not object']
  if (!Array.isArray(j.files) || !j.files.length) errs.push('files empty')
  if (!Array.isArray(j.taskIntent) || !j.taskIntent.length) errs.push('taskIntent empty')
  for (const f of (j.files || [])) {
    if (!f || typeof f.path !== 'string') errs.push('file.path invalid')
    if (!Array.isArray(f.actions)) errs.push('file.actions invalid')
  }
  return errs
}

function resolveLoads(intent, mapping) {
  const keys = new Set()
  const hitLog = []
  for (const f of intent.files) {
    for (const act of (f.actions || [])) {
      for (const r of mapping.rules) {
        const typeOK = r.fileType === f.type || r.fileType === 'other'
        if (r.intent === act && typeOK) {
          for (const k of r.load) keys.add(k)
          hitLog.push(`${act}/${f.type} -> ${r.load.join(',')}`)
        }
      }
    }
  }
  for (const t of (intent.taskIntent || [])) {
    for (const r of mapping.rules) {
      if (r.intent === t && r.fileType === 'other') {
        for (const k of r.load) keys.add(k)
        hitLog.push(`${t} -> ${r.load.join(',')}`)
      }
    }
  }
  keys.add('RULES')
  return { keys: [...keys], hitLog }
}

function loadAll(keys) {
  const out = []
  for (const k of keys) {
    try {
      const txt = execFileSync('node', [LOADER, '--for', k], { cwd: ROOT, encoding: 'utf8', timeout: 15000 })
      if (txt && txt.trim()) out.push({ key: k, text: txt, tokens: estimateTokens(txt) })
    } catch (e) {
      out.push({ key: k, text: '', tokens: 0, error: String(e.message || e).slice(0, 80) })
    }
  }
  return out
}

function trimToBudget(items, budget) {
  // 按 tokens 升序优先塞入（保留多而小），超预算标记 skip
  const sorted = [...items].sort((a, b) => (a.tokens || 0) - (b.tokens || 0))
  const kept = []; const skipped = []
  let used = 0
  for (const it of sorted) {
    if (used + (it.tokens || 0) <= budget) { kept.push(it); used += it.tokens || 0 }
    else { skipped.push(it.key)
    }
  }
  return { kept, skipped, used }
}

function buildContext(intent, mapping, budget) {
  const { keys, hitLog } = resolveLoads(intent, mapping)
  const loaded = loadAll(keys)
  const { kept, skipped, used } = trimToBudget(loaded, budget)
  const parts = []
  parts.push('<!-- airunner-context-pack v1 -->')
  parts.push(`<!-- loads: ${keys.join(',')} -->`)
  parts.push(`<!-- tokens: ${used}/${budget} -->`)
  if (skipped.length) parts.push(`<!-- budget-skipped: ${skipped.join(',')} -->`)
  parts.push('')
  for (const it of kept) {
    parts.push(`\n===== [${it.key}] =====\n`)
    parts.push(it.text)
  }
  return { content: parts.join('\n'), keys, hitLog, used, skipped }
}

function main() {
  const args = parseArgs(process.argv)
  if (args.selfTest) {
    const fake = { files: [{ path: 'client/x.vue', type: 'vue', actions: ['改样式'] }], taskIntent: ['修 bug'] }
    const mapping = JSON.parse(fs.readFileSync(MAPPING, 'utf8'))
    const errs = validateIntent(fake)
    if (errs.length) { console.error('validate failed:', errs); process.exit(1) }
    const r = buildContext(fake, mapping, 8000)
    console.log(`self-test ok: keys=${r.keys.length} used=${r.used} skipped=${r.skipped.length}`)
    process.exit(0)
  }
  if (!args.input) { console.error('usage: context-pack.cjs <intent.json>'); process.exit(2) }
  const intent = JSON.parse(fs.readFileSync(args.input, 'utf8'))
  const errs = validateIntent(intent)
  if (errs.length) { console.error('intent invalid:', errs.join('; ')); process.exit(2) }
  const mapping = JSON.parse(fs.readFileSync(MAPPING, 'utf8'))
  const r = buildContext(intent, mapping, args.budget)
  if (args.outFile) { fs.writeFileSync(args.outFile, r.content); console.log(`wrote ${args.outFile} (${r.used} tokens)`) }
  else { process.stdout.write(r.content)
  }
}

main()
