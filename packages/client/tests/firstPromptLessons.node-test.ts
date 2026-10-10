// [lessons-inject-parity-guard-v1] 守卫：首问规则头的 lessons 注入必须真的生效。
// [WHY] 原 sessionPromptLessons.node-test.ts 测的 buildLoopInitialPrompt/buildNewSessionPrompt
//   随 auto-loop 收敛（P3b）删除；其 4 组守卫（注入对齐 / 状态行图例 / 窗口卫生 / 预算封顶）
//   已改挂到 first-prompt.ts 的 prependFirstPromptRules（留存路径的真实拼装点）。
// [CONSTRAINT] 用全局 Response 造响应，不用 `as any`；load-rules 有 Promise 缓存，每个用例前必须 clearRulesCache()。
import { afterEach, beforeEach, it, vi } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prependFirstPromptRules } from '../composables/ai/first-prompt.js'
import { clearRulesCache } from '../composables/ai/load-rules.js'
import { LESSONS_BUDGET } from '../composables/ai/load-lessons.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const LESSONS_MD = '> 维护者协议引言（应被丢弃）\n\n## 坑A：某年某月的坑\n正文A\n'
const LESSONS_MARK = '.ai-runner/lessons.md'

function jsonRes(data: unknown): Response {
  return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
}

/**
 * 造一个按 URL + 请求体分派的 fetch 桩
 * [CONSTRAINT] 必须同时覆盖 load-rules 的 files/read(AGENTS.md) 与 load-lessons 的 files/read(lessons.md)，
 *              否则两者会拿到同一份内容，测试变成假通过
 */
function makeFetch(opts: { lessons?: string | null, throwAll?: boolean, matches?: Array<{ title: string, body: string, state: string, score: number, matched: string[] }>, matchThrows?: boolean, matchStatus?: number } = {}) {
  return async (url: string, init?: { body?: string }): Promise<Response> => {
    if (opts.throwAll) throw new Error('network down')
    const u = String(url)
    const body = String(init?.body || '')
    if (u.includes('/__ai/preset/system')) return jsonRes({ ok: true, content: 'SYSTEM-OK' })
    if (u.includes('/__ai/files/read')) {
      if (body.includes('lessons.md')) {
        if (opts.lessons === null) return jsonRes({ files: [{ path: LESSONS_MARK, error: 'ENOENT' }] })
        return jsonRes({ files: [{ path: LESSONS_MARK, content: opts.lessons ?? LESSONS_MD }] })
      }
      return jsonRes({ files: [{ path: 'AGENTS.md', content: 'AGENTS-OK' }] })
    }
    if (u.includes('/__ai/skills/match')) return jsonRes({ ok: true, matches: [] })
    if (u.includes('/__ai/lessons/match')) {
      if (opts.matchThrows) throw new Error('lessons/match down')
      if (opts.matchStatus) return new Response('{}', { status: opts.matchStatus })
      return jsonRes({ ok: true, query: '', matches: opts.matches ?? [] })
    }
    throw new Error(`unexpected url: ${u}`)
  }
}

beforeEach(() => clearRulesCache())
afterEach(() => vi.unstubAllGlobals())

it('prependFirstPromptRules：注入 lessons 块并剥掉维护者引言', async () => {
  vi.stubGlobal('fetch', makeFetch())
  const p = await prependFirstPromptRules('把 X 做完')
  assert.ok(p.includes(LESSONS_MARK), '首问必须带 lessons')
  assert.ok(p.includes('坑A'), 'lessons 正文必须进入 prompt')
  assert.ok(!p.includes('维护者协议引言'), '维护者引言应被 stripPreface 丢弃')
  assert.ok(p.includes('把 X 做完'), '问题正文不得被挤掉')
  assert.ok(p.includes('# 会话首问规则（自动携带）'), '规则头标记必须在位')
  assert.ok(p.includes('SYSTEM-OK'), '规则注入必须保留')
})

it('网络全挂：降级但保留业务正文，不抛错', async () => {
  vi.stubGlobal('fetch', makeFetch({ throwAll: true }))
  const a = await prependFirstPromptRules('目标Z')
  assert.equal(a, '目标Z')
})

it('lessons 读不到：注入块为空，其余内容不受影响', async () => {
  vi.stubGlobal('fetch', makeFetch({ lessons: null }))
  const p = await prependFirstPromptRules('目标W')
  assert.ok(!p.includes(LESSONS_MARK))
  assert.ok(p.includes('SYSTEM-OK') && p.includes('目标W'))
})

it('幂等：prompt 已含 SYSTEM.md 块时原样返回', async () => {
  vi.stubGlobal('fetch', makeFetch())
  const raw = '<file path="SYSTEM.md">x</file>\n\n问题'
  const p = await prependFirstPromptRules(raw)
  assert.equal(p, raw, '已含规则块时应原样返回（防重复注入）')
})
it('lessons 超预算：按条目边界截断且优先保留最新条目', async () => {
  const big = (t: string) => `## ${t}\n${'x'.repeat(4000)}\n`
  vi.stubGlobal('fetch', makeFetch({ lessons: big('旧坑') + big('新坑') }))
  const p = await prependFirstPromptRules('目标V')
  assert.ok(p.includes('新坑'), '应优先保留文件尾（较新）的条目')
  assert.ok(!p.includes('旧坑'), '超出预算的旧条目应被截断')
})

// ── 状态行图例：台账里有「已被推翻 / 已失效」的条目时，头部必须给出解释 ─────────
// [lessons-status-legend-v1] 背景：lessons.md 的条目带状态行 —— `[VERIFIED]` / `[REJECTED]`
//   （实测推翻，**正文是错的**）/ `[STALE]`（曾为真、机制已改，**现在不适用**）/ `（待复核）`。
//   AI 读到一条「某 bug 存在」的 STALE 正文，无从知道它已被修好，会照着**已失效的现象**去修。
//   图例是这条链上唯一的解释来源，故守卫它：
//   ① 四种状态可辨识；② `[REJECTED]`/`[STALE]` 必须是「叫停」语义，不能与 `[VERIFIED]` 同档；
//   ③ 图例挂在 head 上、不进字符预算 ⇒ 截断路径下同样必须在。

const LESSONS_MIXED_STATUS = [
  '## 已修掉的坑',
  '[STALE] 2026-10-05 A · 机制已改，缺口已修',
  '正文：旧现象描述',
  '',
  '## 已被推翻的坑',
  '[REJECTED] 2026-10-05 A · 实测推翻',
  '正文：错误归因',
  '',
].join('\n')

it('注入块必须携带状态行图例：四种状态都可辨识', async () => {
  vi.stubGlobal('fetch', makeFetch({ lessons: LESSONS_MIXED_STATUS }))
  const p = await prependFirstPromptRules('目标L')
  for (const s of ['`[VERIFIED]`', '`[REJECTED]`', '`[STALE]`', '`（待复核）`']) {
    assert.ok(p.includes(s), `图例缺少状态 ${s}：AI 无从判断该条结论是否仍然成立`)
  }
  assert.ok(p.includes('已修掉的坑'), '图例不得挤掉条目正文')
})

it('图例语义：REJECTED / STALE 必须是否定措辞，不能与 VERIFIED 同档', async () => {
  vi.stubGlobal('fetch', makeFetch({ lessons: LESSONS_MIXED_STATUS }))
  const p = await prependFirstPromptRules('目标M')
  assert.match(p, /\[REJECTED\][^\n]*不要照做/, 'REJECTED 未说明「正文是错的」：会被当现行结论')
  assert.match(p, /\[STALE\][^\n]*不适用/, 'STALE 未说明「现已不适用」：会被当成现存的 bug 去修')
  assert.match(p, /\[VERIFIED\][^\n]*铁律/)
})

it('截断路径下图例同样存在（图例不计入条目预算）', async () => {
  const big = (t: string) => `## ${t}\n${'x'.repeat(4000)}\n`
  vi.stubGlobal('fetch', makeFetch({ lessons: big('旧坑') + big('新坑') }))
  const p = await prependFirstPromptRules('目标N')
  assert.ok(p.includes('`[STALE]`'), '截断时图例丢了：条目只剩状态标记，AI 无从解读')
  assert.match(p, /仅注入最近 1\/2 条/, '截断提示本身也必须在位')
})
// ── 注入窗口的状态质量：全局比例达标 ≠ 窗口干净 ─────────────────────────────
// [lessons-window-hygiene-v1] 背景：台账是 append-only ⇒ 新条目（缺省即未复核）必然堆在尾部，
//   而注入窗口从文件尾往前截 ⇒「全局达标、窗口全脏」是真实盲区。
// [CONSTRAINT] 读**真实台账**、走**真实实现**（buildLessonsBlock 的窗口选择），不复制算法。
const WINDOW_PENDING_MAX = 0.6

function injectedEntries(prompt: string): string[] {
  const m = prompt.match(/<file path="\.ai-runner\/lessons\.md">([\s\S]*?)<\/file>/)
  if (!m) return []
  const i = m[1].indexOf('\n## ')
  if (i < 0) return []
  return m[1].slice(i + 1).split(/\n(?=## )/).filter(e => e.startsWith('## '))
}

function isPendingEntry(e: string): boolean {
  // 与 lessons-status.cjs 同口径：`## 标题` 后的**首个非空行**才是状态行
  const first = e.split('\n').slice(1).find(l => l.trim() !== '') || ''
  return !/^\[(?:VERIFIED|REJECTED|STALE)\]/i.test(first.trim())
}

it('注入窗口内待复核占比 ≤ 60%：全局达标不等于 AI 看到的是干净的', async () => {
  const md = fs.readFileSync(path.join(ROOT, '.ai-runner', 'lessons.md'), 'utf8')
  vi.stubGlobal('fetch', makeFetch({ lessons: md }))
  const p = await prependFirstPromptRules('目标H')
  const entries = injectedEntries(p)
  assert.ok(entries.length >= 3, `窗口内只解析到 ${entries.length} 条，判据可能被真空满足`)
  const pending = entries.filter(isPendingEntry)
  const ratio = pending.length / entries.length
  assert.ok(
    ratio <= WINDOW_PENDING_MAX,
    `注入窗口内待复核 ${pending.length}/${entries.length} = ${(ratio * 100).toFixed(0)}%，超 ${WINDOW_PENDING_MAX * 100}%。`
    + ` AI 只读窗口 ⇒ 积压必须清到窗口以外才有意义。窗口内首条待复核：${pending[0]?.split('\n')[0] || '(无)'}`
  )
})

it('检索命中超预算：条目部分仍 ≤ LESSONS_BUDGET（变异：去掉封顶必红）', async () => {
  const big = (t: string) => ({ title: t, body: `${'x'.repeat(5000)}`, state: 'pending', score: 9, matched: [] })
  vi.stubGlobal('fetch', makeFetch({ matches: [big('坑一'), big('坑二'), big('坑三')] }))
  const p = await prependFirstPromptRules('目标B')
  const entries = injectedEntries(p)
  assert.ok(entries.length >= 1, '检索命中却零注入：判据可能被真空满足')
  const used = entries.reduce((n, e) => n + e.length, 0)
  assert.ok(used <= LESSONS_BUDGET, `条目部分 ${used} 字符 > 预算 ${LESSONS_BUDGET}：封顶失效`)
})

it('检索端点 500：回退尾截断，块非空（变异：删回退分支必红）', async () => {
  vi.stubGlobal('fetch', makeFetch({ matchStatus: 500 }))
  const p = await prependFirstPromptRules('目标R')
  assert.ok(p.includes(LESSONS_MARK), '检索失败后未回退尾截断：块为空 = 丢掉了既往踩坑')
  assert.ok(p.includes('坑A'), '回退路径必须真的注入条目，而非空壳')
})

it('检索请求抛错：同样回退尾截断，不抛到调用方', async () => {
  vi.stubGlobal('fetch', makeFetch({ matchThrows: true }))
  const p = await prependFirstPromptRules('目标S')
  assert.ok(p.includes('坑A'), '抛错路径也必须回退，不得让异常穿出')
})
