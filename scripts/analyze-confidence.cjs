#!/usr/bin/env node
// @desc 能力自知：从 @desc/@why 抽「把握度代理信号」，对比实际 exitCode，输出校准曲线
// @why tier3-1：元机制三 能力自知；把握度自评 + 校准曲线 + 不确定性传递
// 用法: node scripts/analyze-confidence.cjs

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const RUNS = path.join(ROOT, '.ai-runner/runs')
const OUT_JSON = path.join(ROOT, 'docs/plan/phase0/D-confidence-calibration.json')
const OUT_MD = path.join(ROOT, 'docs/plan/phase0/D-confidence-calibration.md')

function walkRounds(d, out) {
  let e; try { e = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
  for (const x of e) {
    const p = path.join(d, x.name)
    if (x.isDirectory()) walkRounds(p, out)
    else if (/^round-\d+\.json$/.test(x.name)) out.push(p)
  }
}

function headOf(sc) {
  if (!sc) return ''
  if (typeof sc === 'string') return sc
  return [sc.head, sc.body].filter(Boolean).join('\n')
}

// 置信词表：出现则降置信；把握度信号只做相对分级
const HEDGE = /可能|也许|大概|似乎|应该|或许|推测|不确定|待确认|待验证|尚需|未能确定|uncertain|maybe|perhaps|might|probably/i
const STRONG = /已验证|全绿|通过|确定性|确认|guaranteed|verified|all green|exact/i
const DONE_SIG = /收尾|完成|done|finished|全部完成|收工/i
const EVIDENCE = /(?:exit|code)[^\n]*\d|tsc.*(?:0|通过)|lint.*通过|test.*passed|(?:pnpm|yarn|npm).*(?:tsc|lint|test|verify)/i

// 综合等级：strong > hedged 优先；无信号时按 done 存在性
function classifyConfidence(c) {
  const bag = (`${c.desc} ${c.why}`).trim()
  const hedged = HEDGE.test(bag)
  const strong = STRONG.test(bag)
  const done = DONE_SIG.test(bag)
  const evidence = EVIDENCE.test(bag)
  // 四档：high / medium / low / unknown
  let tier = 'unknown'
  if (hedged && !strong) tier = 'low'
  else if (strong && (done || evidence)) tier = 'high'
  else if (done || evidence) tier = 'medium'
  else if (!hedged) tier = 'medium'
  return { tier, hedged, strong, done, evidence }
}

function main() {
  const files = []
  walkRounds(RUNS, files)
  const recs = []
  for (const f of files) {
    let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8')) } catch { continue }
    const head = headOf(j.script)
    const g = function (tag) {
      const re = new RegExp(`@${tag}\\s*:?\\s*(.+)`, 'i')
      const m = re.exec(head)
      return m ? m[1].trim().slice(0, 200) : ''
    }
    const c = { desc: g('desc'), why: g('why') }
    const conf = classifyConfidence(c)
    const exit = Number(j.exitCode ?? 0)
    recs.push({ runId: j.runId || path.basename(path.dirname(f)), round: j.round, exit, tier: conf.tier, conf })
  }

  // 混淆矩阵
  const tiers = ['high', 'medium', 'low', 'unknown']
  const matrix = {}
  for (const t of tiers) matrix[t] = { n: 0, ok: 0, fail: 0, rate: 0 }
  for (const r of recs) {
    const m = matrix[r.tier]
    m.n += 1
    if (r.exit === 0) m.ok += 1; else m.fail += 1
  }
  for (const t of tiers) { const m = matrix[t]; m.rate = m.n ? Math.round(m.ok / m.n * 1000) / 10 : 0 }

  // 校准偏差：high 档实际成功率越低 → 过自信越严重
  const expected = { high: 95, medium: 80, low: 50, unknown: null }
  const gaps = []
  for (const t of ['high', 'medium', 'low']) {
    const e = expected[t]
    const a = matrix[t].rate
    const g = a - e
    gaps.push({ tier: t, n: matrix[t].n, expected: e, actual: a, gap: Math.round(g * 10) / 10, verdict: Math.abs(g) < 10 ? '校准良好' : (g < 0 ? '过自信' : '过保守') })
  }

  const result = {
    generatedAt: new Date().toISOString(),
    totalRounds: recs.length,
    matrix,
    calibration: gaps,
    overconfident: gaps.filter(g => g.verdict === '过自信'),
  }
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true })
  fs.writeFileSync(OUT_JSON, JSON.stringify(result, null, 2), 'utf8')

  const out = []
  function w() { for (let i = 0; i < arguments.length; i++) out.push(arguments[i]) }
  w('# 能力自知与校准曲线（tier3-1）', '')
  w(`> 生成时间：${result.generatedAt}  样本：round 总数 ${recs.length}`, '')
  w('')
  w('## 把握度代理信号（启发式）', '')
  w('- HEDGE 词（可能/也许/待/或许/uncertain）→ low')
  w('- STRONG 词（已验证/全绿/通过/verified）且含 done 或证据 → high')
  w('- done 声明或含证据词 → medium')
  w('- 其余 → unknown', '')
  w('')
  w('## 混淆矩阵', '')
  w('| 档位 | 样本 | 成功 | 失败 | 成功率% |', '')
  w('| :--- | ---: | ---: | ---: | ---: |')
  for (const t of tiers) { const m = matrix[t]; w(`| ${t} | ${m.n} | ${m.ok} | ${m.fail} | ${m.rate} |`) }
  w('')
  w('## 校准偏差（对照预期成功率）', '')
  w('| 档位 | 样本 | 预期% | 实际% | 偏差 | 判定 |', '')
  w('| :--- | ---: | ---: | ---: | ---: | :--- |')
  for (const g of gaps) w(`| ${g.tier} | ${g.n} | ${g.expected} | ${g.actual} | ${g.gap} | ${g.verdict} |`)
  w('')
  w('## 反推建议', '')
  if (result.overconfident.length) {
    for (const g of result.overconfident) {
      w(`- **${g.tier}** 档实际成功率 ${g.actual}% vs 预期 ${g.expected}% → 过自信；应提升校准精度（在 @desc/@why 里写具体证据而非笼统断言）`, '')
    }
  } else {
    w('- 所有档位校准良好（偏差 < 10 个百分点），暂无需干预', '')
  }
  w('')
  w('## 不确定性传递', '')
  w('- 若 high 档样本 < 20，校准结论不稳；建议累积更多轮次后再评估', '')
  w('- unknown 档若占比 > 50%，说明历史记录里缺乏明确完成声明，可优先给 RULES 补「发送前自查」', '')
  w('')
  fs.writeFileSync(OUT_MD, out.join('\n'), 'utf8')
  console.log(`[write] ${path.relative(ROOT, OUT_JSON)}`)
  console.log(`[write] ${path.relative(ROOT, OUT_MD)} (${out.length} 行)`)
  console.log(`[stat] rounds=${recs.length}`)
  for (const t of tiers) { const m = matrix[t]; console.log(`  ${t.padEnd(8)} n=${String(m.n).padStart(4)} ok=${String(m.ok).padStart(4)} rate=${m.rate}%`) }
  console.log('[校准]')
  for (const g of gaps) console.log(`  ${g.tier.padEnd(8)} exp=${g.expected}% act=${g.actual}% gap=${g.gap} → ${g.verdict}`)
}

main()
