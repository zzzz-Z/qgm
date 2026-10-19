// @desc SSOT 边界守卫：AGENTS.md 的具名常量引用必须在源码中真实存在
// @why 2026-10-10：AGENTS.md「自动循环没有轮次上限」节声明 LOOP_HARD_MAX_ROUNDS = 50，
//   而 auto-loop 子系统已删、该常量全仓零命中 => 悬空声明。AGENTS.md 自我声明
//   「不重述执行规则、唯一来源是 SYSTEM.md」，但该声明无机器守卫；本文件只守**可机检的那一半**。
// [判据] 扫描 AGENTS.md 中反引号包裹的 UPPER_SNAKE 常量名，逐个在源码中查字面量出现。
//   找不到 => 红。变异：加回 LOOP_HARD_MAX_ROUNDS => 红。
// [明确排除] 不守「是否违反职责边界」这类语义判断——那会退化成维护豁免白名单。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const agents = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8')

/** 从 AGENTS.md 提取反引号包裹的 UPPER_SNAKE 常量名（至少一个下划线，避免捕获泛词） */
function extractConstants(text: string): string[] {
  const out = new Set<string>()
  const re = /`([A-Z][A-Z0-9]*_[A-Z0-9_]+)`/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) out.add(m[1])
  return [...out].sort()
}

/** 递归收集源码文件（排除文档 / dist / tests / node_modules / .ai-runner） */
function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (['node_modules', 'dist', '.git', '.ai-runner', 'tests', 'coverage'].includes(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { walk(p, out); continue }
    if (!/\.(?:ts|vue|cjs|mjs|js|json)$/.test(e.name)) continue
    out.push(p)
  }
  return out
}

const SOURCE_DIRS: string[] = ['packages', 'apps', 'scripts', 'bin']
const sourceFiles: string[] = SOURCE_DIRS.flatMap((d: string) => walk(path.join(ROOT, d)))

/** 源码中是否存在该常量的字面量（读一次全量缓存，避免逐常量重复 IO） */
let cache: string | null = null
function allSourceText(): string {
  if (cache !== null) return cache
  let joined = ''
  for (const f of sourceFiles) {
    try { joined += `${fs.readFileSync(f, 'utf8')}\n` } catch { /* 单文件失败不阻断 */ }
  }
  cache = joined
  return cache
}

const declared = extractConstants(agents)

test('G1 AGENTS.md 中至少声明了一个具名常量（防扫描器失效导致真空通过）', () => {
  // 变异：改正则让它匹配不到任何常量 => 红（拒绝真空）
  assert.ok(declared.length >= 1, `扫描器未命中任何常量：${JSON.stringify(declared)}`)
})

test('G2 AGENTS.md 引用的每个 UPPER_SNAKE 常量名必须在源码中真实存在', () => {
  const haystack = allSourceText()
  const missing = declared.filter((name: string) => !haystack.includes(name))
  assert.deepEqual(missing, [], `AGENTS.md 引用了源码中不存在的常量（悬空声明）：${missing.join(', ')}`)
})

test('G3 SYSTEM.md §0 之后的正文不得引用工作区级的 AGENTS.md', () => {
  const system = fs.readFileSync(path.join(ROOT, 'packages/core/SYSTEM.md'), 'utf8')
  // 头部说明块（§0 之前）已声明层级关系，允许提及；§0 之后的正文属规则主体，不得反向依赖工作区级索引
  const bodyStart = system.indexOf('## §0')
  assert.ok(bodyStart > -1, 'SYSTEM.md 找不到 §0 标题')
  const body = system.slice(bodyStart)
  // 变异：在 §0 之后任意位置加回 AGENTS.md 引用 ⇒ 本测试红
  assert.ok(
    !body.includes('AGENTS.md'),
    'SYSTEM.md §0 之后的正文引用了工作区级的 AGENTS.md（应用级规则不得反向依赖）',
  )
})

test('G4 SYSTEM.md §0 之后的正文不得含工作区专属信息（路径 / 端口 / 宿主命令）', () => {
  // [WHY] 文件头自述「不含任何工作区特定信息」；曾把测试路径、源码路径、端口与宿主命令
  //   散在各章「承重：」行与正文里，换工作区即失效。本判据把该承诺钉成机器可检项。
  // [CONSTRAINT] 只扫 §0 之后的正文（头部说明块允许声明层级关系）；端口按本仓契约值列举。
  const system = fs.readFileSync(path.join(ROOT, 'packages/core/SYSTEM.md'), 'utf8')
  const at = system.indexOf('## §0')
  assert.ok(at > -1, 'SYSTEM.md 找不到 §0 标题')
  const body = system.slice(at)
  const banned: Array<[string, RegExp]> = [
    ['工作区路径 packages/', /packages\//],
    ['工作区路径 apps/', /apps\//],
    ['宿主命令 session:start', /session:start/],
    ['进程管理器 pm2', /pm2/],
    ['回环地址', /127\.0\.0\.1|localhost/],
    ['宿主端口', /\b(?:5175|5178|5274|5275|8091)\b/],
  ]
  const hits = banned.filter(([, re]: [string, RegExp]) => re.test(body)).map(([name]: [string, RegExp]) => name)
  assert.deepEqual(hits, [], `SYSTEM.md §0 之后正文含工作区专属信息：${hits.join('、')}`)
})
