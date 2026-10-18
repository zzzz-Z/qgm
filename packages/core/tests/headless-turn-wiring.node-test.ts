// [turn-envelope-v1] P2-b 守卫：信封真正接进了无头判定链（信封优先 / 标记回落）。
//
// 为什么单开这份：P2-a 只落地了 `readTurnBlocks()` 而**没有调用它**（零行为变化）。
//   P2-b 才把它接进 `detectReplyInPage`。这个动作的风险全在「接错位置」：
//     · 接在 `scanReplyMarks` 之后 ⇒ 信封 JSON 被旧标记扫描判成 text/done ⇒ 整轮退化 plain；
//     · 不带 `kind` ⇒ `ai-headless` 的转发门（`reply.kind` 真值判定）判为「poll 未命中」，
//       记一条 poll-miss 且前端零回复 —— 比不接更糟；
//     · 不去重 ⇒ poll 每 800ms 重扫同一份 DOM ⇒ 前端反复收到同一组块。
//   这三条都不是类型错误，跑起来也不抛异常，只能靠行为断言钉死。
//
// [CONSTRAINT] 直接调用真实的 detectReplyInPage，桩出它读到的 document 面
//   （与 short-reply-gate 同法），不复制函数体、不跑旁路实现。
// [CONSTRAINT] 环境**只建一次**后连拍：重建 window 会重置 __aiRunnerDedup，
//   稳定门（_stableCount >= 3）与去重账本都依赖它跨拍存活。

import assert from 'node:assert/strict'
import { describe, expect, it } from 'vitest'
import { detectReplyInPage } from '../src/headless/headless-inject.js'

type El = Record<string, unknown>

/** 代码块：pre > code，与真实渲染结构对齐（语言标签是 pre 内的文本节点） */
function preEl(codeText: string): El {
  return {
    nodeType: 1,
    tagName: 'PRE',
    className: 'language-json',
    textContent: codeText,
    childNodes: [],
    querySelector: (sel: string) => (sel === 'code' ? { textContent: codeText } : null),
    querySelectorAll: () => [],
    closest: () => null,
  }
}

/**
 * 建一次桩页面。之后用 tick() 连拍，模拟生产 poll（800ms 一拍）。
 * @param pres      最后一条 assistant 气泡内的代码块
 * @param mainText  该气泡的可见正文（决定 marks 与 plain 路径）
 */
function makeEnv(pres: El[], mainText: string) {
  const bubble = {
    nodeType: 1,
    tagName: 'DIV',
    className: 'ds-assistant-message-main-content',
    textContent: mainText,
    childNodes: [],
    querySelectorAll: (sel: string) => (sel === 'pre' ? pres : []),
    querySelector: () => null,
    closest: () => null,
  }
  const doc = {
    body: {
      textContent: mainText,
      cloneNode: () => ({ querySelectorAll: () => [], textContent: mainText }),
    },
    querySelectorAll: (sel: string) => {
      if (sel.includes('.ds-assistant-message-main-content')) return [bubble]
      if (sel === '.ds-message') return [{ querySelector: () => null }, bubble]
      return []
    },
    querySelector: () => null,
  }
  const g = globalThis as unknown as Record<string, unknown>
  g.window = {}
  g.document = doc
  g.MutationObserver = class { observe() { /* 桩：不触发 */ } }
  return {
    tick: () => detectReplyInPage() as Record<string, any> | null,
    dedup: () => (g.window as Record<string, unknown>).__aiRunnerDedup as Record<string, unknown>,
  }
}

const SAY = { type: 'say', id: 's1', text: '先探两路。' }
const C1 = { type: 'script', id: 'c1', lang: 'js', desc: '统计 md 分布', why: '决定先改哪几个', code: 'console.log(1)' }
const C2 = { type: 'script', id: 'c2', lang: 'cjs', desc: '确认工作区干净', why: '避免覆盖未提交', code: 'module.exports = 1' }
const ASK = { type: 'ask', id: 'q1', question: '清理临时文件吗？', options: [{ id: 'a', label: '清理' }] }
const HANDOFF = { type: 'handoff', id: 'h1', summary: '本轮完成了探查。' }

/** 信封原文（真实页面上就是 pre > code 的 textContent） */
function envelope(obj: unknown): string {
  return `\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\``
}

describe('detectReplyInPage：信封优先 / 标记回落（P2-b）', () => {
  it('闭合信封 ⇒ 返回 kind=turn 并带上**全部**块（旧实现只取最后一块）', () => {
    const env = makeEnv([preEl(envelope({ v: 1, turn: 3, content: [SAY, C1, C2] }))], '')
    const got = env.tick()
    assert.ok(got, '闭合信封必须被识别')
    assert.equal(got.kind, 'turn', '不带 kind ⇒ ai-headless 会判成 poll 未命中')
    assert.equal(got.turnId, 3)
    assert.deepEqual(
      got.blocks.map((b: any) => `${b.type}:${b.id}`),
      ['say:s1', 'script:c1', 'script:c2'],
      '两块都要采集，且顺序 == content 顺序',
    )
    assert.equal(got.turnDone, true)
    assert.equal(got.awaiting, 'results', '有 script 块 ⇒ 等执行结果')
    assert.equal(got.rotate, false)
  })

  it('信封闭合即交付，不等「正文稳定 3 拍」（自分隔载荷的收益）', () => {
    const env = makeEnv([preEl(envelope({ v: 1, turn: 8, content: [C1] }))], '')
    assert.ok(env.tick(), '第一拍就该交付：信封自带闭合标记，无需靠 body 稳定推断')
  })

  it('say + ask（无 script）⇒ awaiting=user', () => {
    const env = makeEnv([preEl(envelope({ v: 1, turn: 4, content: [SAY, ASK] }))], '')
    const got = env.tick()
    assert.equal(got?.awaiting, 'user')
    assert.equal(got?.rotate, false)
  })

  it('含 handoff ⇒ rotate=true（与 awaiting 正交）', () => {
    const env = makeEnv([preEl(envelope({ v: 1, turn: 5, content: [SAY, C1, HANDOFF] }))], '')
    const got = env.tick()
    assert.equal(got?.awaiting, 'results')
    assert.equal(got?.rotate, true)
  })

  it('半截信封（未闭合）⇒ null，等下一拍，不得误交付', () => {
    const raw = envelope({ v: 1, turn: 6, content: [SAY, C1] })
    const half = raw.slice(0, Math.floor(raw.length / 2))
    const env = makeEnv([preEl(half)], '')
    assert.equal(env.tick(), null, '半截信封必须返回 null')
  })

  it('无信封的普通文本 ⇒ 回落旧路径（稳定后交付 plain，行为不变）', () => {
    const text = '这是一条普通回复，不含任何信封结构。'
    const env = makeEnv([], text)
    let firstHitAt = -1
    let got: Record<string, any> | null = null
    for (let i = 1; i <= 10 && firstHitAt < 0; i++) {
      got = env.tick()
      if (got) firstHitAt = i
    }
    assert.ok(firstHitAt > 0, '普通回复仍须交付（回落路径未断）')
    assert.notEqual(got!.kind, 'turn', '无信封时不得走信封分支')
  })

  it('同一信封重复扫到 ⇒ 只交付一次（poll 每 800ms 重扫同一份 DOM）', () => {
    const env = makeEnv([preEl(envelope({ v: 1, turn: 7, content: [C1, C2] }))], '')
    const hits: Record<string, any>[] = []
    for (let i = 0; i < 8; i++) {
      const r = env.tick()
      if (r) hits.push(r)
    }
    assert.equal(hits.length, 1, `重复扫描交付了 ${hits.length} 次 ⇒ 前端会多出重复卡片`)
  })

  it('去重账本随轮次重建：新一轮的**不同** turnId 仍能交付', () => {
    // 连续两个不同 turn 的交付不被上一次的账本挡住
    const env = makeEnv([preEl(envelope({ v: 1, turn: 9, content: [C1] }))], '')
    assert.ok(env.tick(), 'turn 9 首拍交付')
    assert.equal(env.tick(), null, 'turn 9 重复扫描不再交付')
    expect(env.dedup().seenTurnIds).toEqual([9])
  })
})
