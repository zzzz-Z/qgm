// [api-surface-parity-v1] 「教学层 ↔ 门面」同形守卫：SYSTEM.md §3.2 与 ai-guard 注入的
// __AI__ JSDoc 是每轮/每会话强注入的两块教学文本，它们教的名字与签名必须与
// helpers/index.cjs 装配出的真实门面一致，否则等于每轮教 AI 调一个不存在的方法。
// @why 2026-10-08 实测三处漂移（判据承重，逐条都能复现旧红）：
//   ① ai-guard 的 JSDoc 写 `patchFile(p, { find, replace })` —— 谎报对象参数，
//      真实签名是位置参数 patchFile(file, anchor, replacement, opts)，照抄必然
//      ANCHOR_NOT_FOUND（实测抛 `anchorHead:"[object Object]"`）；
//   ② JSDoc 与 SYSTEM.md 都教 `exists(p)`，但 io.cjs 有实现、index.cjs 漏转发
//      ⇒ 照文档写恒 `TypeError: __AI__.exists is not a function`（本次已补转发）；
//   ③ JSDoc 教 `listDir(p)` —— 源码与 dist 产物**全仓无任何实现**，纯幻觉 API。
// @why 守卫形态：正向断言「文档提到的 API 都真实存在」，反向断言「门面上被文档点名的高频
//   API 不缺席」。刻意**不**做「门面每个 public 成员都必须在文档里」——门面有 61 个
//   public 成员，其中 10 个（appendText/fileInfo/assert* 系列/exitNeed*/symbol/
//   lessons/tasks）是有意不写进速查的，强推会把守卫变成填表任务并诱发灌水。
// CHANGE-IMPACT: 门面上新增 public API 不必改文档（不红）；文档新增一个不存在的 API 名必红。
import { expect, test } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { injectAiJsdoc } from '../src/post-run/ai-guard.js'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const require = createRequire(import.meta.url)

// 装载真实门面：helpers.cjs 顶层把 __AI__ 挂到 global（helpers-index-v1 的唯一注入点）。
// 环境里无 AI_RUNNER_TOOL_LOG ⇒ _openToolLog 直接 return，本 require 不写任何盘。
require(path.join(ROOT, 'packages/core/src/helpers.cjs'))
// [ts7017] globalThis 无索引签名，需先窄化再取；不是 any，只是给这一句一个显式形状。
const AI = (globalThis as unknown as { __AI__: Record<string, unknown> }).__AI__

// 文档里出现的非 API 词：JS/shell 关键字、错误码常量、诊断字段名。
// 判据只关心「长得像 API 的小驼峰」——错误码是 SHOUTING_SNAKE，反引号里天然可区分。
const NOT_API = new Set([
  '__AI__',
  'await',
  'import',
  'export',
  'sudo',
  'file',
  'done',
  'at',
  'count',
  'hint',
  'nearLines',
  'opts',
])

/**
 * 抽出 SYSTEM.md §3.2 里点名的 API 名。两种合法书写形态都要覆盖：
 *   ① `` `deleteFile(p,opts?)` `` / `` `walk(p,{ext?,skip?})` `` —— 反引号内标识符紧跟 `(`；
 *   ② `` `exists` `` —— 纯标识符闭合。
 * [WHY] 早先只匹配 ②（纯标识符）⇒ 带参形态整批漏抽；改成「反引号 + 标识符 + 任意非反引号」
 *   又过宽 ⇒ 把 `rm -rf`、`node --check` 这类命令当成 API 名抓出来（实测 T2 红）。
 *   故要求形态①必须紧跟 `(`，形态②必须直接闭合，两者都不允许中间夹空格。
 */
function apiNamesIn(text: string): string[] {
  const out = new Set<string>()
  const accept = (n: string, index: number) => {
    if (NOT_API.has(n)) return
    if (/^[A-Z0-9_]+$/.test(n)) return
    // [api-surface-parity-v1] 否定语境豁免：文档显式写「无 `listDir`，勿凭空调用」时，
    //   那是在**禁止**用它，不是在教用它。若不豁免，警告句自己会被抓成幻觉 API，
    //   逼人把警告删掉——那等于让守卫抑制纠错信息。判据看紧邻前缀（token 前 6 字），
    //   刻意用小窗口：只吃紧贴的「无/勿/禁/没」，不吃更远处的字。
    const before = text.slice(Math.max(0, index - 6), index)
    if (/[无勿禁没]\s*$/.test(before)) return
    out.add(n)
  }
  for (const m of text.matchAll(/`([A-Z_$][\w$]*)\(/gi)) accept(m[1], m.index)
  for (const m of text.matchAll(/`([A-Z_$][\w$]*)`/gi)) accept(m[1], m.index)
  return [...out]
}

/**
 * 抽出 JSDoc 里点名的 API 成员。
 * [WHY] 不能复用 apiNamesIn：JSDoc 是裸写 `__AI__.readText(p) / writeText(p, s) / exists(p)`，
 *   **没有反引号**，且每行只有首个 API 带 `__AI__.` 前缀，其余是斜杠分隔的裸名。
 *   早先误用反引号抽取 ⇒ 抽出 0 个名字 ⇒ missing 恒为空 ⇒ 判据恒真，
 *   变异「抽掉 exists 转发」竟然全绿；只按 `__AI__.` 前缀抽也只拿到 4 个，
 *   靠下限断言红而非靠语义。两种失效都是「假绿/假红」⇒ 抽取必须覆盖真实书写形态。
 * [变更-影响] 判据从恒真变成真语义：删掉 exists 转发会因「exists 是被点名的 API 却不存在」而红。
 */
function aiRefsIn(doc: string): string[] {
  const out = new Set<string>()
  // ① 带前缀的显式引用
  for (const m of doc.matchAll(/__AI__\.([A-Za-z_$][\w$]*)/g)) out.add(m[1])
  // ② 速查行里的裸名调用：name( / name(...)，用负向断言排掉属性访问与标识符内部匹配
  for (const m of doc.matchAll(/(?<![.\w$])([a-z][\w$]*)\s*\(/g)) {
    if (NOT_API.has(m[1])) continue
    out.add(m[1])
  }
  return [...out]
}

test('T1 门面本身装载成功（前置：守卫不能建立在空对象上）', () => {
  expect(typeof AI).toBe('object')
  expect(Object.keys(AI).length).toBeGreaterThan(30)
})

test('T2 SYSTEM.md §3.2 提到的每个 API 在门面上真实存在', () => {
  const md = fs.readFileSync(path.join(ROOT, 'packages/core/SYSTEM.md'), 'utf8')
  const a = md.indexOf('### §3.2')
  const b = md.indexOf('### §3.3', a)
  expect(a).toBeGreaterThan(-1)
  expect(b).toBeGreaterThan(a)
  const names = apiNamesIn(md.slice(a, b))
  expect(names.length).toBeGreaterThan(20)
  // 变异：把 §3.2 里某个 API 改成一个幻觉名（如 listDir）⇒ 下方断言红
  const missing = names.filter(n => typeof AI[n] === 'undefined')
  expect(missing, `SYSTEM.md §3.2 教了门面上不存在的 API：${missing.join(' ')}`).toEqual([])
})

test('T3 ai-guard 注入的 JSDoc 不含幻觉 API（listDir 已删、exists 已补转发）', () => {
  const doc = injectAiJsdoc('const x = 1\n')
  expect(doc).toContain('__AI__ 运行时沙箱')
  const names = aiRefsIn(doc)
  // 下限断言：抽取器一旦失效（如 JSDoc 改成反引号包裹），这里先红，而不是让 missing 恒真
  expect(names.length, 'JSDoc 里点名的 API 数异常，抽取器可能已失效').toBeGreaterThanOrEqual(10)
  // 变异：把 walk 改回 listDir ⇒ 下面 missing 断言红
  const missing = names.filter(n => typeof AI[n] === 'undefined')
  expect(missing, `注入的 JSDoc 教了不存在的 API：${missing.join(' ')}`).toEqual([])
  // 回归锚点：这三个曾各自漂移过，逐字钉住
  expect(doc).toContain('exists(p)')
  expect(doc).not.toContain('listDir')
})

test('T4 JSDoc 不得把 patchFile 教成对象参数（真实是位置参数，arity=4）', () => {
  const doc = injectAiJsdoc('const x = 1\n')
  expect(typeof AI.patchFile).toBe('function')
  expect((AI.patchFile as (...a: unknown[]) => unknown).length).toBe(4)
  // 变异：改回 `patchFile(p, { find, replace })` ⇒ 两条均红
  expect(doc).not.toMatch(/patchFile\s*\([^)]*\{/)
  // [design-v1] 瘦身后 JSDoc 用的是 patchFile(file, anchor, replacement, opts?)；
  //   断言改指新形态（两者都是位置参数，语义等价）。
  expect(doc).toContain('patchFile(file, anchor, replacement, opts?)')
})

test('T5 JSDoc 里 cwdMust 的写法与真实 arity 一致（曾误写成零参 cwdMust()）', () => {
  expect((AI.cwdMust as (...a: unknown[]) => unknown).length).toBe(1)
  // 变异：改回 `cwdMust()` ⇒ 红
  expect(injectAiJsdoc('const x = 1\n')).not.toContain('cwdMust()')
})

test('T6 否定语境豁免是窄的：警告位放行、教学位仍拦（防豁免退化成放行一切）', () => {
  // SYSTEM.md 现状：``无 `listDir` `` 属禁止性警告 ⇒ 不得被抓成幻觉 API
  expect(apiNamesIn('；`exists(p)`；`walk(p,…)`（列目录用这个；**无 `listDir`**，勿凭空调用）'))
    .not
    .toContain('listDir')
  // 但同一名字挪到教学位（前面是分号分隔的并列项）⇒ 必须被抽出来判缺失
  const teaching = '`deleteFile(p)`；`listDir(p)`；`walk(p,…)`'
  expect(apiNamesIn(teaching), 'listDir 挪到教学位后未被抽出 ⇒ 否定豁免过宽，守卫已失效')
    .toContain('listDir')
})
test('T7 教学层（SYSTEM.md §3.2）提到的签名必须与真实门面 arity 一致', () => {
  // [design-v1] 消除「双写漂移」的结构性根因：签名唯一 SSOT 是 helpers/*.cjs 的 JSDoc。
  // 判据：SYSTEM.md §3.2 里每个「`name(args)`」形态，参数个数必须与门面真实 arity 一致。
  // 反例承重：`patchFile(p, {find, replace})` = 2 参，真实 arity = 4 ⇒ 红。
  // 优点：无需维护白名单；门面 arity 变化时教学层自动对账。
  const md = fs.readFileSync(path.join(ROOT, 'packages/core/SYSTEM.md'), 'utf8')
  const a = md.indexOf('### §3.2')
  const b = md.indexOf('### §3.3', a)
  expect(a).toBeGreaterThan(-1)
  const s32 = md.slice(a, b)

  // 顶层逗号计数：忽略 {} [] () 内的逗号。
  function countTopArgs(sig: string): number {
    const t = sig.trim()
    if (!t) return 0
    let depth = 0; let n = 1
    for (const c of t) {
      if (c === '{' || c === '[' || c === '(') depth++
      else if (c === '}' || c === ']' || c === ')') depth--
      else if (c === ',' && depth === 0) n++
    }
    return n
  }

  const offenders: string[] = []
  for (const m of s32.matchAll(/`([A-Z_$][\w$]*)\(([^`]*)\)`/gi)) {
    const name = m[1]
    const args = m[2]
    const fn = AI[name]
    // 非门面 API（如浏览器方法 browser.cssom 走的是点号形态，不会命中此正则）
    if (typeof fn !== 'function') continue
    const realArity = (fn as (...a: unknown[]) => unknown).length
    const claimArity = countTopArgs(args)
    if (claimArity !== realArity) {
      offenders.push(`${name}: 文档写 ${claimArity} 参，门面 ${realArity} 参`)
    }
  }
  expect(offenders, `SYSTEM.md §3.2 的签名与门面 arity 不一致：\n${offenders.join('\n')}`).toEqual([])
})
