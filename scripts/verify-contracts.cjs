#!/usr/bin/env node
// @desc 契约验证：从 round-N.json 抽 @plan/@done/@verify 声明，与实际 exitCode/pipeline/changes 对比，累积偏差
// @why tier2b-2：反推误判场景，识别「声称完成但失败」「声称验证但无 verify」两类偏差

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const RUNS = path.join(ROOT, '.ai-runner/runs')
const OUT_JSON = path.join(ROOT, 'docs/plan/phase0/C-contract-drift.json')
const OUT_MD = path.join(ROOT, 'docs/plan/phase0/C-contract-drift.md')

function walkRounds(d, out) {
  let e; try { e = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
  for (const x of e) {
    const p = path.join(d, x.name)
    if (x.isDirectory()) walkRounds(p, out)
    else if (/^round-\d+\.json$/.test(x.name)) out.push(p)
  }
}

// 从 script.head 抽声明（@plan/@done/@verify/@desc）
// [tier2b-2-fix] 抽出 head 归一化，避免 && / || 混用触发 no-mixed-operators
function pickHead(head) {
  if (typeof head === 'string') return head
  if (!head) return ''
  const h = head.head || head.body || ''
  return h
}

function parseClaims(head) {
  const txt = pickHead(head)
  const g = function (tag) {
    const re = new RegExp(`@${tag}\\s*:?\\s*(.+)`, 'i')
    const m = re.exec(txt)
    return m ? m[1].trim().slice(0, 240) : ''
  }
  return {
    desc: g('desc'),
    plan: g('plan'),
    done: g('done'),
    verify: g('verify'),
  }
}

// 判断本轮是否"声称完成"：@done 非空，或 @desc/@plan 里含"收尾/finish/done/完成"
function looksLikeCompletion(c) {
  if (c.done) return true
  const t = (`${c.desc} ${c.plan}`)
  return /收尾|done|完成|全部完成|收工|finish/i.test(t)
}

// 判断本轮是否"声称验证"：@done 或 @verify 里含验证词
function looksLikeVerified(c) {
  const t = (`${c.done} ${c.verify} ${c.desc}`)
  return /闸门|verify|通过|全绿|test|tsc|lint|校验/i.test(t)
}

function main() {
  const files = []
  walkRounds(RUNS, files)
  const records = []
  for (const f of files) {
    let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8')) } catch { continue }
    const head = j.script && (j.script.head || j.script)
    const c = parseClaims(head)
    const exit = Number(j.exitCode ?? 0)
    const changes = Array.isArray(j.changes) ? j.changes.length : 0
    const pipe = j.pipeline || {}
    const failedSegs = Object.keys(pipe).filter((k) => { const v = pipe[k] || {}; return v.status === 'failed' || v.error })
    const claimsDone = looksLikeCompletion(c)
    const claimsVerified = looksLikeVerified(c)

    // 偏差类型
    const drift = []
    if (claimsDone && exit !== 0) drift.push(`声称完成但 exit=${exit}`)
    if (claimsVerified && exit !== 0) drift.push(`声称验证通过但 exit=${exit}`)
    if (claimsDone && changes === 0 && exit === 0) drift.push('声称完成但零改动（可能空转）')
    if (claimsVerified && failedSegs.length > 0) drift.push(`声称验证但 pipeline 失败段：${failedSegs.join(',')}`)

    records.push({
      runId: j.runId || path.basename(path.dirname(f)),
      round: j.round,
      ts: j.ts || 0,
      exit,
      durationMs: Number(j.durationMs || 0),
      changeCount: changes,
      failedSegs,
      claimsDone,
      claimsVerified,
      claims: c,
      drift,
      file: path.relative(ROOT, f),
    })
  }

  // 汇总
  const withDrift = records.filter(r => r.drift.length > 0)
  const byKind = {}
  for (const r of withDrift) {
    for (const d of r.drift) {
      const k = d.split('：')[0].split('（')[0].trim()
      byKind[k] = (byKind[k] || 0) + 1
    }
  }
  const verdict = withDrift.length === 0 ? '无偏差' : (withDrift.length <= records.length * 0.1 ? '低偏差' : '偏高（需排查）')

  const result = {
    generatedAt: new Date().toISOString(),
    totalRounds: records.length,
    driftRounds: withDrift.length,
    driftRate: Math.round(withDrift.length / records.length * 1000) / 10,
    verdict,
    byKind,
    sampleDrift: withDrift.slice(0, 20).map(r => ({
      runId: r.runId,
      round: r.round,
      exit: r.exit,
      changeCount: r.changeCount,
      desc: r.claims.desc,
      done: r.claims.done,
      drift: r.drift,
    })),
  }
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true })
  fs.writeFileSync(OUT_JSON, JSON.stringify(result, null, 2), 'utf8')

  const out = []
  function w() { for (let i = 0; i < arguments.length; i++) out.push(arguments[i]) }
  w('# 契约验证闭环报告（tier2b-2）', '')
  w(`> 生成时间：${result.generatedAt}`, '')
  w('')
  w('## 总览', '')
  w(`    round 总数       = ${records.length}`, '')
  w(`    含偏差轮次       = ${withDrift.length} (${result.driftRate}%)`, '')
  w(`    判定             = ${verdict}`, '')
  w('')
  w('## 偏差分类', '')
  if (!Object.keys(byKind).length) { w('（无）', '')
  }
  else {
    w('| 偏差类型 | 次数 |', '')
    w('| :--- | ---: |')
    for (const k of Object.keys(byKind).sort((a, b) => byKind[b] - byKind[a])) w(`| ${k} | ${byKind[k]} |`)
  }
  w('')
  w('## 偏差样本（前 20）', '')
  for (const s of result.sampleDrift) {
    w(`### ${s.runId} R${s.round} exit=${s.exit} 改动=${s.changeCount}`, '')
    w(`- desc: ${s.desc || '(空)'}`)
    w(`- done: ${s.done || '(空)'}`)
    w(`- drift: ${s.drift.join(' / ')}`)
    w('')
  }
  w('## 反推建议', '')
  w('- 「声称完成但 exit≠0」→ 收尾轮的 @done 与实际不符，需修 RULES 的发送前自查清单', '')
  w('- 「声称验证但 pipeline 失败」→ 验证词被滥用，应在 @done 里明确写出证据（命令 + 退出码）', '')
  w('- 「声称完成但零改动」→ 空转轮，可能是重复脚本（SHA-256 去重未生效）或只读探针误标', '')
  w('')
  fs.writeFileSync(OUT_MD, out.join('\n'), 'utf8')
  console.log(`[write] ${path.relative(ROOT, OUT_JSON)}`)
  console.log(`[write] ${path.relative(ROOT, OUT_MD)} (${out.length} 行)`)
  console.log(`[stat] rounds=${records.length} drift=${withDrift.length} (${result.driftRate}%) verdict=${verdict}`)
  for (const k of Object.keys(byKind)) console.log(`  ${String(byKind[k]).padStart(4)}  ${k}`)
}

main()
