// [lessons-inject-parity-guard-v1] 守卫：lessons 注入必须同时覆盖「循环首轮」与「新会话首问」。
// [WHY] load-lessons.ts 与 session-prompt.ts 的注释都声明「被两个 prompt 构建函数消费」，
//       但历史上只有 buildLoopInitialPrompt 真的接了——声明与实现漂移，且无任何测试会发现。
//       本测试把这条契约钉死：任一入口漏接，测试立刻红。
// [CONSTRAINT] 用全局 Response 造响应，不用 `as any`；load-rules 有 Promise 缓存，每个用例前必须 clearRulesCache()。
import { afterEach, beforeEach, it, vi } from 'vitest'
import assert from 'node:assert/strict'
import { buildLoopInitialPrompt, buildNewSessionPrompt } from '../composables/ai/session-prompt.js'
import { clearRulesCache } from '../composables/ai/load-rules.js'

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
function makeFetch(opts: { lessons?: string | null, throwAll?: boolean } = {}) {
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
    throw new Error(`unexpected url: ${u}`)
  }
}

beforeEach(() => clearRulesCache())
afterEach(() => vi.unstubAllGlobals())

it('buildLoopInitialPrompt：注入 lessons 块并剥掉维护者引言', async () => {
  vi.stubGlobal('fetch', makeFetch())
  const p = await buildLoopInitialPrompt('把 X 做完')
  assert.ok(p.includes(LESSONS_MARK), '循环首轮必须带 lessons')
  assert.ok(p.includes('坑A'), 'lessons 正文必须进入 prompt')
  assert.ok(!p.includes('维护者协议引言'), '维护者引言应被 stripPreface 丢弃')
  assert.ok(p.includes('把 X 做完'), '目标正文不得被挤掉')
})

it('buildNewSessionPrompt：同样注入 lessons（与循环首轮对齐）', async () => {
  vi.stubGlobal('fetch', makeFetch())
  const p = await buildNewSessionPrompt('上一轮做了 Y', '把 X 做完')
  assert.ok(p.includes(LESSONS_MARK), '新会话首问必须带 lessons —— 漏接即本断言失败')
  assert.ok(p.includes('坑A'), 'lessons 正文必须进入 prompt')
  assert.ok(p.includes('上一轮做了 Y'), '会话总结正文不得被挤掉')
})

it('网络全挂：两个入口都降级但保留业务正文，不抛错', async () => {
  vi.stubGlobal('fetch', makeFetch({ throwAll: true }))
  const a = await buildLoopInitialPrompt('目标Z')
  assert.equal(a, '目标Z')
  const b = await buildNewSessionPrompt('总结Z', '目标Z')
  assert.equal(b, '总结Z')
})

it('lessons 读不到：注入块为空，其余内容不受影响', async () => {
  vi.stubGlobal('fetch', makeFetch({ lessons: null }))
  const p = await buildLoopInitialPrompt('目标W')
  assert.ok(!p.includes(LESSONS_MARK))
  assert.ok(p.includes('SYSTEM-OK') && p.includes('目标W'))
})

it('lessons 超预算：按条目边界截断且优先保留最新条目', async () => {
  const big = (t: string) => `## ${t}\n${'x'.repeat(4000)}\n`
  vi.stubGlobal('fetch', makeFetch({ lessons: big('旧坑') + big('新坑') }))
  const p = await buildLoopInitialPrompt('目标V')
  assert.ok(p.includes('新坑'), '应优先保留文件尾（较新）的条目')
  assert.ok(!p.includes('旧坑'), '超出 6000 预算的旧条目应被截断')
})

// ── 状态行图例：台账里有「已被推翻 / 已失效」的条目时，头部必须给出解释 ─────────────
// [lessons-status-legend-v1] 背景：lessons.md 的条目带状态行 —— `[VERIFIED]` / `[REJECTED]`
//   （实测推翻，**正文是错的**）/ `[STALE]`（曾为真、机制已改，**现在不适用**）/ `（待复核）`。
//   实测（治理后 56 条）：尾 6,000 字符注入窗口内含 **2 条 `[STALE]`**，而头部消息此前只说
//   「缺省 = 待复核」——AI 读到一条「某 bug 存在」的 STALE 正文，无从知道它已被修好，
//   会照着**已失效的现象**去修。图例是这条链上唯一的解释来源，故守卫它：
//   ① 四种状态可辨识；② `[REJECTED]`/`[STALE]` 必须是「叫停」语义，不能与 `[VERIFIED]` 同档；
//   ③ 图例挂在 `head` 上、不进 6,000 字符条目预算 ⇒ 截断路径下同样必须在。

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
  const p = await buildLoopInitialPrompt('目标L')
  for (const s of ['`[VERIFIED]`', '`[REJECTED]`', '`[STALE]`', '`（待复核）`']) {
    assert.ok(p.includes(s), `图例缺少状态 ${s}：AI 无从判断该条结论是否仍然成立`)
  }
  assert.ok(p.includes('已修掉的坑'), '图例不得挤掉条目正文')
})

it('图例语义：REJECTED / STALE 必须是否定措辞，不能与 VERIFIED 同档', async () => {
  vi.stubGlobal('fetch', makeFetch({ lessons: LESSONS_MIXED_STATUS }))
  const p = await buildLoopInitialPrompt('目标M')
  assert.match(p, /\[REJECTED\][^\n]*不要照做/, 'REJECTED 未说明「正文是错的」：会被当现行结论')
  assert.match(p, /\[STALE\][^\n]*不适用/, 'STALE 未说明「现已不适用」：会被当成现存的 bug 去修')
  // 双向：不许为了强调否定而把 VERIFIED 也写成参考级，否则真实约束被弱化
  assert.match(p, /\[VERIFIED\][^\n]*铁律/)
})

it('截断路径下图例同样存在（图例不计入 6000 字符条目预算）', async () => {
  const big = (t: string) => `## ${t}\n${'x'.repeat(4000)}\n`
  vi.stubGlobal('fetch', makeFetch({ lessons: big('旧坑') + big('新坑') }))
  const p = await buildLoopInitialPrompt('目标N')
  assert.ok(p.includes('`[STALE]`'), '截断时图例丢了：条目只剩状态标记，AI 无从解读')
  assert.match(p, /仅注入最近 1\/2 条/, '截断提示本身也必须在位')
})
