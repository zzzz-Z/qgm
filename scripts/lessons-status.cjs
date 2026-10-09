#!/usr/bin/env node
// @desc: 汇总 .ai-runner/lessons.md 的复核状态——待复核清单 / 已复核统计
// @why: lessons 由 DONE 总结自动采集（attach-ws.ts），但「谁验过、结论是否仍成立」不可见。
//   采集 ≠ 沉淀：没有复核闸门，应用端自述的坑真假不分（实测已有条目被推翻）。
// @plan: lessons-status [--json|--pending|--strict|--selftest]
'use strict'
const fs = require('node:fs')
const path = require('node:path')
// [lessons-parse-shared-v1] 解析实现抽到共享模块：与 hygiene 守卫同源，消除两套口径。
const { parseLessons: sharedParseLessons, parseStateLine: sharedParseStateLine } = require('./lessons-parse.cjs')

const ROOT = process.cwd()
const FILE = path.join(ROOT, '.ai-runner', 'lessons.md')
const NL = String.fromCharCode(10)

/**
 * 解析状态行：形如 `[VERIFIED] 2026-10-04 A · <证据>`。
 * [CONSTRAINT] 只认条目**首个非空行**——正文里出现的 `[VERIFIED]` 是散文引用，不算数。
 * WHY: 会议检测器曾因 `[RESOLVED]` 出现在图例里而虚高（把说明文字当下文），此处同类风险。
 */
const parseStateLine = sharedParseStateLine

/**
 * 把 lessons.md 解析成条目数组。
 * [CHANGE-IMPACT] 纯解析，无副作用、不写盘。
 */
const parseLessons = sharedParseLessons

// [lessons-review-v1] lessons 复核状态的唯一聚合口径：待复核清单 / 三态计数。
// WHY: 采集 ≠ 沉淀，锚点盯住本文件确保「谁验过」永远有机器可查的出口。
function summarize(items) {
  const counts = { VERIFIED: 0, REJECTED: 0, STALE: 0, UNVERIFIED: 0 }
  for (const it of items) counts[it.status] += 1
  const pendingTitles = items.filter((x) => { return x.status === 'UNVERIFIED' }).map((x) => { return x.title })
  return {
    file: FILE,
    total: items.length,
    verified: counts.VERIFIED,
    rejected: counts.REJECTED,
    stale: counts.STALE,
    pending: counts.UNVERIFIED,
    pendingTitles,
    items,
  }
}

function load() {
  let raw = ''
  try { raw = fs.readFileSync(FILE, 'utf8') } catch { raw = '' }
  return summarize(parseLessons(raw))
}

/** 纯函数自测：不依赖磁盘文件，故可在任意 cwd 下证明判据曾红过。 */
function runSelftest() {
  const cases = [
    ['空文件 → 0 条', '', 0, 0],
    ['无状态行 → 待复核', `## A${NL}正文${NL}`, 1, 1],
    ['标 VERIFIED → 已复核', `## A${NL}[VERIFIED] 2026-10-04 A · 证据${NL}正文${NL}`, 1, 0],
    ['标题后空行仍识别', `## A${NL}${NL}[VERIFIED] e${NL}`, 1, 0],
    ['状态行不在首行 → 不算', `## A${NL}正文${NL}[VERIFIED] e${NL}`, 1, 1],
    ['小写标记 → 识别', `## A${NL}[verified] e${NL}`, 1, 0],
    ['未知标记 → 待复核', `## A${NL}[FOO] bar${NL}`, 1, 1],
    ['显式 UNVERIFIED → 仍待复核', `## A${NL}[UNVERIFIED] x${NL}`, 1, 1],
    ['一级标题不算条目', `# Lessons${NL}${NL}## A${NL}[VERIFIED] e${NL}`, 1, 0],
    ['标题含字面量不误判', `## 关于 [VERIFIED] 的说明${NL}正文${NL}`, 1, 1],
  ]
  let bad = 0
  for (const c of cases) {
    const items = parseLessons(c[1])
    const s = summarize(items)
    const okTotal = s.total === c[2]
    const okPending = s.pending === c[3]
    if (!okTotal || !okPending) {
      bad += 1
      console.log(`  X ${c[0]} — 期望 total=${c[2]} pending=${c[3]}，实得 total=${s.total} pending=${s.pending}`)
    }
  }
  const mixed = summarize(parseLessons(`## A${NL}[REJECTED] e${NL}## B${NL}[STALE] e${NL}## C${NL}z${NL}`))
  if (!(mixed.total === 3 && mixed.rejected === 1 && mixed.stale === 1 && mixed.pending === 1)) {
    bad += 1
    console.log(`  X 混合统计 — 实得 ${JSON.stringify(mixed)}`)
  }
  const ev = parseStateLine('[VERIFIED] 2026-10-04 A · helpers.cjs:216')
  if (!ev || ev.evidence !== '2026-10-04 A · helpers.cjs:216') {
    bad += 1
    console.log('  X 证据文本提取失败')
  }
  const total = cases.length + 2
  console.log(bad ? `X lessons-status 自测 ${bad}/${total} 个用例失败` : `OK lessons-status 自测 ${total} 个用例全部通过`)
  return bad
}

const args = process.argv.slice(2)
function has(f) { return args.includes(f) }

if (has('--selftest')) {
  process.exit(runSelftest() ? 1 : 0)
}

const s = load()

// [CONSTRAINT] --json 模式下 stdout 必须**只有** JSON——调用方（session-start.mjs）直接 JSON.parse。
if (has('--json')) {
  console.log(JSON.stringify(s, null, 2))
} else {
  console.log(`lessons: ${s.total} 条（verified ${s.verified} / rejected ${s.rejected} / stale ${s.stale} / pending ${s.pending}）`)
  if (has('--pending') || s.pending) {
    if (s.pending) {
      console.log(`待复核 ${s.pending} 条：`)
      for (const t of s.pendingTitles) console.log(`  - ${t}`)
    } else {
      console.log('待复核 0 条')
    }
  }
}

// 缺省恒 0：待复核是待办而非错误。--strict 供闸门按需升级为阻塞信号。
process.exitCode = has('--strict') && s.pending > 0 ? 3 : 0
