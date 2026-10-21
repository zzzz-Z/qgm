// [turn-block-frame-v1] 块帧 → 卡片 的采信守卫。
//
// 这层守卫专门盯一类缺陷：**解析对了、字段也传了，但渲染时被丢掉**。
// 现存先例：`attach-ws.ts:147` 把脚本 desc/why 硬编码成空串，前端只显示空描述，
// 而所有「解析正确」的断言全绿——因为丢字段发生在解析之后。
// 所以这里不只断言「有卡」，还断言「值等于输入」（采信），而不只是「非空」。
//
// 另一条判据：`ask` 的 options 必须来自块，不再解析文本。旧路径 parseAsk 靠猜编号列表，
// 一旦模型换了排版就丢选项；块帧让选项成为**字段**，这条断言钉的就是「没退回猜」。

import { describe, expect, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { buildOneCard } from '../utils/timeline-build.js'
import type { QuestionItem, ScriptItem, TextItem } from '../utils/timeline-build.js'

/** 构造一条 ai:block 事件（payload 形状与 attach-ws 发出的帧一致） */
function blockEvent(block: Record<string, unknown>, key = 1, ts = 1_700_000_000_000) {
  return { id: key, kind: 'ai:block', ts, payload: { block } }
}

function asText(item: unknown): TextItem {
  const t = item as TextItem
  expect(t.type, '应为文本卡').toBe('text')
  return t
}

describe('ai:block → 卡片：say', () => {
  test('say 渲染为文本卡，正文与输入逐字相等（采信，不只看非空）', () => {
    const text = '先同时探两路：目录分布 + git 状态。'
    const card = asText(buildOneCard(blockEvent({ turnId: 7, blockId: 'say_1', seq: 0, type: 'say', text })))
    expect(card.text).toBe(text)
    expect(card.key).toBe('blk-7-say_1')
  })

  test('空 say 不建卡（空文本卡会占掉一行，且没有任何信息）', () => {
    expect(buildOneCard(blockEvent({ turnId: 1, blockId: 'say_1', type: 'say', text: '   ' }))).toBeNull()
  })
})

describe('ai:block → 卡片：ask（选项来自块，不解析文本）', () => {
  test('question + options 逐字段采信，askId 用块 id', () => {
    const options = [{ id: 'a', label: '清理' }, { id: 'b', label: '跳过' }]
    const card = buildOneCard(blockEvent({ turnId: 7, blockId: 'q1', seq: 3, type: 'ask', question: '要顺带清理临时文件吗？', options })) as QuestionItem
    expect(card.type).toBe('question')
    expect(card.text).toBe('要顺带清理临时文件吗？')
    expect(card.options).toEqual(options)
    expect(card.askId).toBe('q1')
    expect(card.answered).toBe(false)
    expect(card.key).toBe('blk-7-q1')
  })

  test('选项里出现文本里没有的内容也能渲染（证明没有退回解析文本）', () => {
    const card = buildOneCard(blockEvent({ turnId: 1, blockId: 'q', type: 'ask', question: '选？', options: [{ id: 'x', label: '甲' }, { id: 'y', label: '乙' }] })) as QuestionItem
    expect(card.options.map(o => o.label)).toEqual(['甲', '乙'])
    expect(card.text, '正文里没有任何列表符号，选项只能来自字段').not.toContain('甲')
  })

  test('无问题又无选项 ⇒ 不建卡（空提问卡无法回答）', () => {
    expect(buildOneCard(blockEvent({ turnId: 1, blockId: 'q', type: 'ask', question: '', options: [] }))).toBeNull()
  })

  // [ask-single-card-v1] 回答态必须**读 payload 顶层**：回答更新打在同一条事件的 updateKey 上，
  //   合并后 answered/answer 与 block 同处 payload。写死 false ⇒ 卡片答完永远停在可点态。
  test('已回答的提问卡：answered/answer 从事件顶层采信（不写死 false）', () => {
    const card = buildOneCard({
      id: 9,
      kind: 'ai:block',
      ts: 1_700_000_000_000,
      payload: {
        updateKey: 'blk-7-q1',
        answered: true,
        answer: '甲',
        block: { turnId: 7, blockId: 'q1', seq: 1, type: 'ask', question: '选哪个？', options: [{ id: 'a', label: '甲' }] },
      },
    }) as QuestionItem
    expect(card.type).toBe('question')
    expect(card.key).toBe('blk-7-q1')
    expect(card.answered, '回答更新打到这条事件后必须认').toBe(true)
    expect(card.answer).toBe('甲')
  })
})

describe('ai:block → 卡片：handoff 与 script', () => {
  test('handoff 渲染为文本卡（交班摘要必须可见，否则轮转是静默行为）', () => {
    const card = asText(buildOneCard(blockEvent({ turnId: 3, blockId: 'h1', type: 'handoff', summary: '上下文要满了，换会话继续' })))
    expect(card.text).toBe('上下文要满了，换会话继续')
  })

  test('script 块不建卡：执行数据在 run:* 里，建占位会与 run:start 的真卡重复', () => {
    const card = buildOneCard(blockEvent({ turnId: 3, blockId: 'c1', type: 'script', lang: 'js', desc: '跑一下', why: '为了验证', code: 'console.log(1)' }))
    expect(card).toBeNull()
  })

  test('未知 type / 缺 block ⇒ null（不抛异常，帧坏了也不该让时间线崩）', () => {
    expect(buildOneCard(blockEvent({ turnId: 1, blockId: 'x', type: 'lane' }))).toBeNull()
    expect(buildOneCard({ id: 1, kind: 'ai:block', ts: 0, payload: {} })).toBeNull()
  })
})

describe('ai:block → 卡片：顺序与 key', () => {
  test('按 seq 逐帧建卡，卡片顺序 == 块顺序', () => {
    const blocks = [
      { turnId: 5, blockId: 'say_1', seq: 0, type: 'say', text: '先说理' },
      { turnId: 5, blockId: 'q1', seq: 1, type: 'ask', question: '选哪个？', options: [{ id: 'a', label: '甲' }] },
      { turnId: 5, blockId: 'h1', seq: 2, type: 'handoff', summary: '换会话' },
    ]
    const keys = blocks.map((b, i) => buildOneCard(blockEvent(b, i + 1))?.key)
    expect(keys).toEqual(['blk-5-say_1', 'blk-5-q1', 'blk-5-h1'])
  })

  test('key 只由 turnId + blockId 决定（同块重发不会产生第二张卡）', () => {
    const b = { turnId: 9, blockId: 'say_1', seq: 0, type: 'say', text: '同一条' }
    expect(buildOneCard(blockEvent(b, 1))?.key).toBe(buildOneCard(blockEvent(b, 2))?.key)
  })

  test('不同 turn 的同名 blockId 不串卡', () => {
    const a = buildOneCard(blockEvent({ turnId: 1, blockId: 'say_1', type: 'say', text: 'a' }))
    const b = buildOneCard(blockEvent({ turnId: 2, blockId: 'say_1', type: 'say', text: 'b' }))
    expect(a?.key).not.toBe(b?.key)
  })
})

// [turn-block-frame-v1] 采信守卫必须钉**活渲染路径**，而非只钉纯函数。
// [WHY] 上文全部断言都打 buildOneCard，但 UI 只跑 TerminalPane 的内联 timelineItems builder，
//   两者此前不一致（内联版无 ai:block 分支）⇒ say 块在渲染时被静默丢弃，本文件却依旧全绿——
//   这正是文件头写的「解析对了、字段也传了，但渲染时被丢掉」那类缺陷，只是丢在了纯函数之后。
//   故补源码级断言：活路径必须消费 ai:block 且**委托** buildOneCard（建卡规则单一来源）。
test('活渲染路径（TerminalPane.timelineItems）消费 ai:block 且委托 buildOneCard', () => {
  const tp = fs.readFileSync(path.join(process.cwd(), 'packages/client/components/script/TerminalPane.vue'), 'utf8')
  assert.ok(/\bev\.kind === 'ai:block'/.test(tp), 'TerminalPane 活构建路径应分支处理 ai:block')
  assert.ok(/buildOneCard\(ev\)/.test(tp), 'ai:block 分支应委托 buildOneCard，不得另写一份建卡规则')
})

// 反向：确保这次改动没有动到旧路径的判据（旧 kind 的卡片形状不变）
describe('旧路径未受影响', () => {
  test('ai:plain 仍是文本卡，ai:question 仍是提问卡', () => {
    const plain = buildOneCard({ id: 1, kind: 'ai:plain', ts: 0, payload: { text: '普通回复' } })
    expect((plain as TextItem).type).toBe('text')
    const q = buildOneCard({ id: 2, kind: 'ai:question', ts: 0, payload: { question: '问？', options: [{ id: 'a', label: '甲' }] } }) as QuestionItem
    expect(q.type).toBe('question')
    expect(q.options).toEqual([{ id: 'a', label: '甲' }])
  })

  test('script 块不影响 run:start 建卡（真卡仍要求 desc/why）', () => {
    const run = buildOneCard({ id: 3, kind: 'run:start', ts: 0, payload: { desc: '统计 md', why: '决定先改哪几个', lang: 'js', phase: 'running' } }) as ScriptItem
    expect(run?.type).toBe('script')
    expect(run.desc).toBe('统计 md')
    expect(run.why).toBe('决定先改哪几个')
  })
})
