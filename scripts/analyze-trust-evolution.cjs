#!/usr/bin/env node
// @desc 信任演化：按领域聚合历史决策，出领域信任图谱 + 信任预算建议
// @why tier3-2：元机制二 信任演化；依赖 state.json 的 decisions 数组
// 用法: node scripts/analyze-trust-evolution.cjs

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const ST = path.join(ROOT, '.ai-runner/state.json')
const OUT_JSON = path.join(ROOT, 'docs/plan/phase0/D-trust-evolution.json')
const OUT_MD = path.join(ROOT, 'docs/plan/phase0/D-trust-evolution.md')

// 领域：与 useDecisionPolicy.ts DECISION_TYPES 对齐 + 从 dec.c 关键词推断

const KEYWORDS = [
  { d: 'technicalChoice', re: /选型|方案|框架|库|依赖|架构|design|approach|技术选择/i },
  { d: 'planDecompose', re: /拆解|分解|计划|阶段|里程碑|todo|step|plan|拆分/i },
  { d: 'planAdjust', re: /调整|重排|改计划|回退|修正计划|replan|reschedule/i },
  { d: 'scriptGenerate', re: /生成|脚本|cjs|bash|node|写文件|落地|build|create/i },
  { d: 'errorFix', re: /修|bug|fix|错误|报错|失败|回归|regression/i },
  { d: 'levelJudge', re: /分级|判定|评估|评级|等级|level|grade|judge/i },
  { d: 'circuitJudge', re: /熔断|急停|中断|停循环|circuit|abort|halt/i },
  { d: 'channelChoice', re: /通道|路径|转发|route|channel|path|way/i },
]

function inferDomain(text) {
  const t = String(text || '')
  for (const k of KEYWORDS) { if (k.re.test(t)) return k.d
  }
  return 'other'
}

function main() {
  let state
  try { state = JSON.parse(fs.readFileSync(ST, 'utf8')) } catch (e) { console.error(`read state failed: ${e.message}`); process.exit(1) }
  const ds = Array.isArray(state.decisions) ? state.decisions : []

  // 按领域聚合
  const buckets = new Map()
  for (const d of ds) {
    const text = [d.c, d.r].filter(Boolean).join(' ')
    const dom = inferDomain(text)
    if (!buckets.has(dom)) buckets.set(dom, { domain: dom, n: 0, samples: [], rejectedTotal: 0, lastTs: '' })
    const b = buckets.get(dom)
    b.n += 1
    if (Array.isArray(d.rej) && d.rej.length) b.rejectedTotal += d.rej.length
    if (b.samples.length < 3) b.samples.push(String(d.c || '').slice(0, 120))
    if (d.t && d.t > b.lastTs) b.lastTs = d.t
  }
  const total = ds.length || 1
  const domains = [...buckets.values()].map((b) => {
    const share = Math.round((b.n / total) * 1000) / 10
    // 信任度启发：占比越高说明该领域越活跃，但拒绝率高 → 信心下降
    const rejectRate = b.n ? Math.round((b.rejectedTotal / b.n) * 1000) / 10 : 0
    const rejRateNorm = Math.min(100, rejectRate)
    const trust = Math.max(20, Math.min(100, Math.round(100 - rejRateNorm * 0.4 - Math.max(0, 30 - share) * 0.5)))
    return { domain: b.domain, n: b.n, share, rejectRate, trust, lastTs: b.lastTs, samples: b.samples }
  }).sort((a, b) => b.n - a.n)

  // 信任预算：全局建议 —— 每 10 分钟最多 N 次打断（基于历史拒绝率）
  const totalRej = domains.reduce((a, d) => a + d.rejectRate * d.n / 100, 0)
  const avgRej = total ? Math.round(totalRej / total * 100) / 100 : 0
  const budgetMaxPerWindow = avgRej > 1.5 ? 2 : (avgRej > 0.8 ? 3 : 5)

  const result = {
    generatedAt: new Date().toISOString(),
    totalDecisions: ds.length,
    domains,
    budget: {
      windowMs: 10 * 60 * 1000,
      maxPerWindow: budgetMaxPerWindow,
      rationale: `avgRej=${avgRej} → 预算 ${budgetMaxPerWindow} 次 / 10min`,
    },
  }
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true })
  fs.writeFileSync(OUT_JSON, JSON.stringify(result, null, 2), 'utf8')

  const out = []
  function w() { for (let i = 0; i < arguments.length; i++) out.push(arguments[i]) }
  w('# 信任演化（tier3-2）', '')
  w(`> 生成时间：${result.generatedAt}  样本决策数：${result.totalDecisions}`, '')
  w('')
  w('## 领域信任图谱', '')
  w('| 领域 | 决策数 | 占比% | 拒绝率% | 信任度 | 最近 |', '')
  w('| :--- | ---: | ---: | ---: | ---: | :--- |')
  for (const d of domains) {
    w(`| ${d.domain} | ${d.n} | ${d.share} | ${d.rejectRate} | ${d.trust} | ${String(d.lastTs).slice(0, 19)} |`)
  }
  w('')
  w('## 信任预算建议', '')
  w(`- 窗口：${result.budget.windowMs / 60000} 分钟`)
  w(`- 上限：${result.budget.maxPerWindow} 次打断 / 窗口`)
  w(`- 依据：${result.budget.rationale}`)
  w('')
  w('## 领域样本', '')
  for (const d of domains) {
    if (!d.samples.length) continue
    w(`### ${d.domain}`, '')
    for (const s of d.samples) w(`- ${s}`)
    w('')
  }
  fs.writeFileSync(OUT_MD, out.join('\n'), 'utf8')
  console.log(`[write] ${path.relative(ROOT, OUT_JSON)}`)
  console.log(`[write] ${path.relative(ROOT, OUT_MD)} (${out.length} 行)`)
  console.log(`[stat] decisions=${ds.length} domains=${domains.length} budget=${result.budget.maxPerWindow}/10min`)
  for (const d of domains) console.log(`  ${d.domain.padEnd(18)} n=${String(d.n).padStart(4)} share=${d.share}% trust=${d.trust}`)
}

main()
