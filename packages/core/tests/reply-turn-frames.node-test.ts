// [turn-block-frame-v1] 块列表 → 线上帧的守卫。
//
// 这一层是「顺序」和「归属」的落点，也是历史上丢字段的地方：
//   `attach-ws.ts` 曾把脚本 desc/why 硬编码成空串（没有地方放它们），前端只能显示空描述。
//   映射器把 desc/why 提升为协议字段后，必须有断言钉住「真值到达帧」，否则同类缺陷换个位置复发。
//
// 五组判据：
//   ① 顺序与 seq：帧顺序 == 数组顺序；seq 取原下标（跳过块留洞，不错位）
//   ② 派生优先级：script > ask > none（组合场景必须钉死，三处推导必然在这里分叉）
//   ③ 字段不串味：say 帧不带 code，script 帧不带 text
//   ④ 未知/缺字段 ⇒ 进 skipped，不抛也不静默丢
//   ⑤ 纯函数：同输入同输出，且不修改入参

import { describe, expect, test } from 'vitest'
import { blocksToFrames, deriveAwaiting, deriveRotate, deriveTurnMode, turnToFrames } from '../src/reply/turn-frames.js'

const SAY = { type: 'say', id: 'say_1', text: '先同时探两路。' }
const C1 = { type: 'script', id: 'c1', lang: 'js', desc: '统计 md 文件分布', why: '决定先改哪几个', code: 'console.log(1)' }
const C2 = { type: 'script', id: 'c2', lang: 'cjs', desc: '确认工作区干净', why: '避免覆盖未提交', code: 'module.exports = 1' }
const ASK = { type: 'ask', id: 'q1', question: '要顺带清理临时文件吗？', options: [{ id: 'a', label: '清理' }, { id: 'b', label: '跳过' }] }
const HANDOFF = { type: 'handoff', id: 'h1', summary: '上下文要满了，换会话继续' }

describe('blocksToFrames：顺序与 seq', () => {
  test('四块齐全 ⇒ 四帧 + 结束帧，顺序与 seq 都由数组决定', () => {
    const r = blocksToFrames(7, [SAY, C1, C2, ASK])
    expect(r.blocks.map(b => b.blockId)).toEqual(['say_1', 'c1', 'c2', 'q1'])
    expect(r.blocks.map(b => b.seq)).toEqual([0, 1, 2, 3])
    expect(r.blocks.every(b => b.turnId === 7)).toBe(true)
    expect(r.end).toEqual({ turnId: 7, awaiting: 'results', mode: 'results', blocks: 4 })
  })

  test('空数组 ⇒ 零帧 + awaiting none（不制造空 turn 的 phantom 帧）', () => {
    const r = blocksToFrames(1, [])
    expect(r.blocks).toEqual([])
    expect(r.end).toEqual({ turnId: 1, awaiting: 'none', mode: 'summary', blocks: 0 })
  })

  test('跳过的块在 seq 上留洞，后续块不错位', () => {
    const r = blocksToFrames(2, [SAY, { type: 'lane', id: 'x' }, C1])
    expect(r.blocks.map(b => b.blockId)).toEqual(['say_1', 'c1'])
    expect(r.blocks.map(b => b.seq), 'seq 必须是原下标，否则前端会把第 3 块当第 2 块占位').toEqual([0, 2])
    expect(r.end.skipped).toEqual(['x:type'])
  })
})

describe('blocksToFrames：派生优先级（组合场景钉死）', () => {
  test('只有 say ⇒ none（本 turn 即总结）', () => {
    expect(deriveAwaiting(blocksToFrames(1, [SAY]).blocks)).toBe('none')
  })

  test('只有 ask ⇒ user（无执行块，停下来等选择）', () => {
    expect(blocksToFrames(1, [SAY, ASK]).end.awaiting).toBe('user')
  })

  test('有 script ⇒ results', () => {
    expect(blocksToFrames(1, [C1]).end.awaiting).toBe('results')
  })

  test('script + ask 同时存在 ⇒ results（先收执行结果，提问卡已随块渲染，用户可随时答）', () => {
    expect(blocksToFrames(1, [C1, ASK]).end.awaiting, '这条优先级是循环行为的分水岭').toBe('results')
    expect(blocksToFrames(1, [ASK, C1]).end.awaiting, '与块顺序无关').toBe('results')
  })

  test('handoff 与 awaiting 正交：轮转标记单独派生', () => {
    const onlyHandoff = blocksToFrames(1, [HANDOFF])
    expect(onlyHandoff.end.awaiting).toBe('none')
    expect(deriveRotate(onlyHandoff.blocks)).toBe(true)
    expect(deriveRotate(blocksToFrames(1, [SAY, C1]).blocks)).toBe(false)
  })
})

describe('blocksToFrames：字段收窄与不串味', () => {
  test('script 帧带 desc / why 真值（attach-ws 曾硬编码空串的那处）', () => {
    const r = blocksToFrames(1, [C1])
    expect(r.blocks[0]).toEqual({
      turnId: 1,
      blockId: 'c1',
      seq: 0,
      type: 'script',
      lang: 'js',
      desc: '统计 md 文件分布',
      why: '决定先改哪几个',
      code: 'console.log(1)',
    })
  })

  test('每类帧只带自己的字段：say 不带 code，script 不带 text', () => {
    const say = blocksToFrames(1, [SAY]).blocks[0]
    expect(Object.keys(say).sort()).toEqual(['blockId', 'seq', 'text', 'turnId', 'type'])
    const script = blocksToFrames(1, [C1]).blocks[0]
    expect(Object.keys(script).sort()).toEqual(['blockId', 'code', 'desc', 'lang', 'seq', 'turnId', 'type', 'why'])
  })

  test('ask 的 options 原样带出；缺 id 补 opt_N；空 label 丢弃', () => {
    const r = blocksToFrames(1, [{ type: 'ask', id: 'q', question: '选？', options: [{ label: '甲' }, { id: 'b', label: '  ' }, { id: 'c', label: '乙' }] }])
    expect(r.blocks[0].options).toEqual([{ id: 'opt_1', label: '甲' }, { id: 'c', label: '乙' }])
  })

  test('lang 白名单外的值 ⇒ skipped，不把 bash 塞进 js/cjs 白名单', () => {
    const r = blocksToFrames(1, [{ ...C1, lang: 'bash' }])
    expect(r.blocks).toEqual([])
    expect(r.end.skipped).toEqual(['c1:lang'])
  })
})

describe('blocksToFrames：坏块不静默', () => {
  test('缺 desc / 缺 code / 缺 summary / 缺 question 各自被点名', () => {
    expect(blocksToFrames(1, [{ ...C1, desc: '' }]).end.skipped).toEqual(['c1:desc'])
    expect(blocksToFrames(1, [{ ...C1, code: '   ' }]).end.skipped).toEqual(['c1:code'])
    expect(blocksToFrames(1, [{ type: 'handoff', id: 'h', summary: '' }]).end.skipped).toEqual(['h:summary'])
    expect(blocksToFrames(1, [{ type: 'ask', id: 'q', question: '' }]).end.skipped).toEqual(['q:question'])
  })

  test('未知 type 不抛异常，进 skipped 且其余块照发', () => {
    const r = blocksToFrames(1, [C1, { type: 'video', id: 'v1', code: 'x' }, SAY])
    expect(r.blocks.map(b => b.blockId)).toEqual(['c1', 'say_1'])
    expect(r.end.skipped).toEqual(['v1:type'])
  })

  test('全部合法时 end 不带 skipped 字段（wire 上不留空数组噪音）', () => {
    const end = blocksToFrames(1, [SAY]).end as { skipped?: string[] }
    expect('skipped' in end).toBe(false)
  })
})

describe('turnToFrames：发帧序列', () => {
  test('四块 ⇒ 四块帧 + 一个结束帧，结束帧必须最后', () => {
    const frames = turnToFrames('w1', 7, [SAY, C1, C2, ASK])
    expect(frames.map(f => f.t)).toEqual(['ai:block', 'ai:block', 'ai:block', 'ai:block', 'ai:turn-end'])
    const blocks = frames.filter(f => f.t === 'ai:block') as { block: { seq: number, blockId: string } }[]
    expect(blocks.map(f => f.block.seq)).toEqual([0, 1, 2, 3])
    expect(blocks.map(f => f.block.blockId)).toEqual(['say_1', 'c1', 'c2', 'q1'])
    const end = frames[frames.length - 1] as { end: { awaiting: string, blocks: number } }
    expect(end.end.awaiting).toBe('results')
    expect(end.end.blocks).toBe(4)
  })

  test('所有帧都带同一个 sid（多标签页并发时不串台）', () => {
    const frames = turnToFrames('win_model_a', 1, [SAY, C1])
    expect(frames.every(f => (f as { sid: string }).sid === 'win_model_a')).toBe(true)
  })

  test('空 turn / 全是坏块 ⇒ 零帧，不发 phantom 结束帧', () => {
    expect(turnToFrames('w', 1, [])).toEqual([])
    expect(turnToFrames('w', 1, [{ type: 'lane', id: 'x' }])).toEqual([])
  })

  test('结束帧透传 skipped（坏块不静默消失）', () => {
    const frames = turnToFrames('w', 2, [SAY, { type: 'lane', id: 'x' }])
    const end = frames[frames.length - 1] as { end: { skipped?: string[] } }
    expect(end.end.skipped).toEqual(['x:type'])
  })
})

describe('[turn-mode-v1] 总结轮显式标记', () => {
  test('仅 say 块 ⇒ mode summary（不再靠 awaiting 反推）', () => {
    const r = blocksToFrames(5, [SAY])
    expect(r.end.mode).toBe('summary')
    expect(r.end.awaiting).toBe('none')
  })

  test('有 script ⇒ results；有 ask ⇒ user', () => {
    expect(blocksToFrames(6, [SAY, C1]).end.mode).toBe('results')
    expect(blocksToFrames(7, [SAY, ASK]).end.mode).toBe('user')
  })

  test('deriveTurnMode 与 deriveAwaiting 同源（none ⇒ summary）', () => {
    const frames = blocksToFrames(8, [SAY]).blocks
    expect(deriveTurnMode(frames)).toBe('summary')
    expect(deriveAwaiting(frames)).toBe('none')
  })
})

describe('blocksToFrames：纯函数', () => {
  test('同输入两次结果完全相同', () => {
    const input = [SAY, C1, ASK]
    expect(blocksToFrames(3, input)).toEqual(blocksToFrames(3, input))
  })

  test('不修改入参（含 options 数组）', () => {
    const input = [SAY, C1, ASK]
    const snapshot = JSON.parse(JSON.stringify(input))
    blocksToFrames(3, input)
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot)
  })
})
