#!/usr/bin/env node
// @desc: 会话首轮 preflight——锚点对账 + lessons + changelog + state + 待办
// @why: 每次新会话首条跑，替代手写多命令；退出码 2 表示状态异常需先处理
// @plan: session-start
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = process.cwd()
const AI_DIR = path.join(ROOT, '.ai-runner')
const NL = String.fromCharCode(10)
let block = false

function head(t) { console.log(`${NL}== ${t} ==`) }
function ok(m) { console.log(`  OK ${m}`) }
function warn(m) { console.log(`  !! ${m}`) }
function err(m) { console.error(`  XX ${m}`) }

head('1. anchors verify')
try {
  const out = execFileSync('node', ['scripts/verify-anchors.cjs'], { cwd: ROOT, encoding: 'utf8' })
  ok(out.trim())
} catch (e) {
  err('anchors failed - disk vs declared mismatch')
  const txt = String(e.stdout || e.stderr || e)
  txt.split(NL).slice(0, 10).forEach((l) => { if (l.trim()) err(l.trim()) })
  block = true
}

head('2. docs index')
try {
  const out = execFileSync('node', ['scripts/verify-docs-index.cjs'], { cwd: ROOT, encoding: 'utf8' })
  ok(out.trim())
} catch (e) {
  err('docs index failed - index vs disk mismatch')
  const txt = String(e.stdout || e.stderr || e)
  txt.split(NL).slice(0, 12).forEach((l) => { if (l.trim()) err(l.trim()) })
  block = true
}

head('3. env')
if (fs.existsSync(path.join(ROOT, 'package.json'))) { ok('package.json ok')
}
else { err('missing package.json'); block = true }
// [struct-check-v1] 本项目没有根 src/：monorepo 真实结构是 packages/{core,client} + apps/{standalone,vite-plugin}
// WHY: 旧检查断言根 src/ 存在，而该目录从未存在 → 每次 preflight 都误报 missing src/，且不计入 block，形同虚设
// CONSTRAINT: 缺任一包目录说明检出损坏或 cwd 不对 → 计入 block，避免后续步骤对着空目录空跑
const REQUIRED_DIRS = [
  'packages/core',
  'packages/client',
  'apps/standalone',
  'apps/vite-plugin',
]
const missingDirs = REQUIRED_DIRS.filter((d) => { return !fs.existsSync(path.join(ROOT, d)) })
if (missingDirs.length) { err(`missing ${missingDirs.join(', ')}`); block = true }
else { ok(`结构 ok (${REQUIRED_DIRS.length} 个包目录)`)
}
// [struct-check-v1] 反向断言：根 src/ 一旦出现说明有文件放错了层，需人工确认
if (fs.existsSync(path.join(ROOT, 'src'))) warn('发现根 src/ —— 本项目无此目录约定，确认是否放错层级')

head('4. lessons')
const lessonsPath = path.join(AI_DIR, 'lessons.md')
if (fs.existsSync(lessonsPath)) {
  // [lessons-review-v1] 显示复核状态，而非只报条数
  // WHY: 只报条数时「哪些已复核 / 哪些还欠复核」不可见——采集来的踩坑真假不分，
  //   且 lessons 长期停在只增不减的收件箱，从不流向长期记忆（沉淀缺中间层）。
  // CONSTRAINT: 有待复核只 warn 不 block——复核是例行工作，不该挡住开发。
  //   状态解析复用 scripts/lessons-status.cjs（单一 SSOT，避免两处规则漂移）。
  //   --json 模式 stdout 必须只有 JSON，否则此处 JSON.parse 会抛。
  let ls = null
  try {
    ls = JSON.parse(execFileSync('node', ['scripts/lessons-status.cjs', '--json'], { cwd: ROOT, encoding: 'utf8' }))
  } catch (e) { warn(`lessons-status 解析失败: ${String(e.message || e).slice(0, 80)}`); block = true }
  if (ls) {
    ok(`${ls.total} entries (verified ${ls.verified} / rejected ${ls.rejected} / stale ${ls.stale} / pending ${ls.pending})`)
    const MAX_SHOW = 20
    ls.items.slice(0, MAX_SHOW).forEach((it) => { console.log(`      [${it.status}] ${it.title}`) })
    if (ls.items.length > MAX_SHOW) console.log(`      ... 另有 ${ls.items.length - MAX_SHOW} 条`)
    if (ls.pending) {
      warn(`${ls.pending} 条待复核 —— 复核与蒸馏归复核方：亲跑证据后标 [VERIFIED]/[REJECTED]/[STALE]`)
    }
    // [lessons-hint-v1] 提供写入入口，避免踩坑记录长期停滞
    console.log(`      采集: DONE 总结写「## 踩坑记录」段自动入库; 手工: pnpm lessons:add "<title>" "<body>"`)
  }
} else { warn('no lessons.md')
}

head('5. changelog')
const clPath = path.join(AI_DIR, 'changelog.jsonl')
if (fs.existsSync(clPath)) {
  const lines = fs.readFileSync(clPath, 'utf8').trim().split(NL)
  ok(`${lines.length} total`)
  lines.slice(-5).forEach((l) => {
    try { const r = JSON.parse(l); console.log(`      ${r.action} ${r.file}`) } catch { /* swallow: 损坏行跳过 */ }
  })
} else { warn('no changelog')
}

head('6. state')
const stPath = path.join(AI_DIR, 'state.json')
if (fs.existsSync(stPath)) {
  const st = JSON.parse(fs.readFileSync(stPath, 'utf8'))
  console.log(`      round=${st.round} status=${st.status}`)
  if (st.goal) console.log(`      goal: ${String(st.goal).slice(0, 100)}`)
  const todo = Array.isArray(st.todo) ? st.todo : []
  const pending = todo.filter((x) => { return x.status !== 'done' })
  ok(`${pending.length} pending / ${todo.length} total`)
  pending.forEach((t) => { console.log(`      [${t.id}] ${String(t.desc).slice(0, 90)}`) })
} else { warn('no state.json')
}

head('7. evidence')
const evDir = path.join(AI_DIR, 'evidence')
if (fs.existsSync(evDir)) {
  // [evidence-count-v1] README 是说明文件，不计入证据数
  const files = fs.readdirSync(evDir).filter((n) => { return n.charAt(0) !== '.' && n !== 'README.md' })
  ok(`${files.length} files`)
} else { warn('no evidence dir')
}

head('8. skills')
const skillsDir = path.join(AI_DIR, 'skills')
// [stack-skill-check-v1] 本项目栈专属技能缺失不阻断，但必须在首轮可见
// WHY: 历史上首轮只按通用词检索，Vue/Vite/Vitest/UnoCSS 零命中，直到用户追问才补
// CONSTRAINT: 只告警不 block——技能是增强项，缺失不应挡住正常开发流程
const STACK_SKILLS = ['vue', 'vite', 'vitest', 'unocss']
if (fs.existsSync(skillsDir)) {
  const installed = fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => { return e.isDirectory() && fs.existsSync(path.join(skillsDir, e.name, 'SKILL.md')) })
    .map((e) => { return e.name })
  ok(`${installed.length} installed`)
  const missingStack = STACK_SKILLS.filter((s) => { return !installed.includes(s) })
  if (missingStack.length) {
    warn(`stack skills missing: ${missingStack.join(', ')} - see AGENTS.md 找技能必须先按技术栈搜`)
  } else { ok(`stack covered (${STACK_SKILLS.join(', ')})`) }
  if (!installed.includes('skill-discovery')) warn('skill-discovery 元技能缺失，检索协议无从执行')
  // [skill-must-read-v1] 把核心约束内联到 preflight，避免会话跳过技能文件
  // WHY: skill-discovery 之前只在磁盘可见，会话不读就不生效，等于没固化
  // CONSTRAINT: 内联的是约束摘要，技术栈列表随依赖变化，此处不重复维护
  console.log('      MUST_READ 找技能（本地优先，不可跳层）:')
  console.log('        ① 先本地: GET /__ai/skills + POST /__ai/skills/match —— 命中即用，不联网')
  console.log('        ② 本地无命中才去联网找候选（栈专属 query 优先，P0 在前，禁止 P2 冒充 P0）')
  console.log('        ③ 安装: POST /__ai/skills/install（服务端强制 已装→本地库→联网；沙箱内 curl 批量下载必撞 60s 超时）')
  console.log('      完整协议: .ai-runner/skills/skill-discovery/SKILL.md')
  // [skill-registry-v2] registry 只是「来源标注」，**不是**「已装清单」——已装清单的唯一事实
  //   来源是上面的磁盘扫描结果。历史上二者漂移过（磁盘 15 / 表 14，缺 pnpm）→ AI 查表得假阴性
  //   「没装」→ 重复联网、在 /run 沙箱手搓 curl 撞 60s 超时 → 自增强死循环。
  //   现在 GET /__ai/skills 每次都会把 registry 收敛到磁盘；此处把漂移量摆到首轮可见。
  const regPath = path.join(skillsDir, '.registry.json')
  if (fs.existsSync(regPath)) {
    try {
      const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'))
      const repos = new Set(reg.entries.map(e => e.source))
      const line = `registry: ${reg.entries.length} entries / ${repos.size} sources（仅来源标注；判断装没装请用磁盘清单）`
      if (reg.entries.length !== installed.length) {
        warn(`${line} - 与磁盘 ${installed.length} 个技能不一致，已漂移；GET /__ai/skills 会自动收敛`)
      } else { console.log(`      ${line}`) }
    } catch { warn('registry parse failed') }
  } else { console.log('      registry 缺失（仅来源标注，不影响已装清单；GET /__ai/skills 会重建）') }
} else { warn('no skills dir - see AGENTS.md 找技能必须先按技术栈搜')
}

head('9. conclusion')
if (block) { err('blocked - fix first'); process.exit(2) }
ok('preflight passed')
