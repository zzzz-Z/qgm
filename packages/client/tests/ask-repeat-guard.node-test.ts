// @vitest-environment happy-dom
// @desc [ask-repeat-guard-v1] ASK 提问「一问一卡」守卫
// @why 2026-10-21 用户截图「ask 刷屏」根因两条叠加：
//   ① 同一条 ask 同时产出**两张卡**（askUser 的 askq-aN 卡 + 块帧的 blk-<turn>-<id> 卡）；
//   ② 有 script 块的 turn 会继续回灌结果，模型把上一轮没拿到答案的 ask **跨轮原样重发**，
//      而跨轮意味着 turnId 递增 ⇒ 既有的 turn|blockId 去重必然失效。
//   两条都不产生任何报错，只表现为时间线被同内容的提问卡淹没，所以必须分别钉住。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  answerAsk,
  askCardKeyOf,
  askSignature,
  askUser,
  claimAskSlot,
  openAskSlotCount,
  releaseAskSlot,
  resetAskSlots,
} from '../composables/ui/useAsk'

// [WHY 用 vi.hoisted] mock 工厂要在 import 之前成形，又要共用同一个 spy 数组；
//   直接在模块体里写 `const emitted` 会撞 import/first 规则。
const { emitted } = vi.hoisted(() => ({
  emitted: [] as Array<{ kind: string, updateKey?: string, payload?: Record<string, unknown> }>,
}))

// [WHY mock 事件流] useAsk 的 emit 目标是单例事件队列；这里只关心「发了几次、打在哪个 key 上」，
//   用 spy 比读真实队列稳定（不依赖 localStorage 初始态）。
vi.mock('../composables/ui/useEventStream', () => ({
  emit: (kind: string, _summary: string, opts?: { updateKey?: string, payload?: Record<string, unknown> }) => {
    emitted.push({ kind, updateKey: opts?.updateKey, payload: opts?.payload })
  },
}))

const OPTS = [{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }]

const readSrc = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8')

beforeEach(() => {
  emitted.length = 0
  resetAskSlots()
})

describe('跨轮重发的同款提问只渲染一次（ask-repeat-guard-v1）', () => {
  it('turnId 变了但内容没变 ⇒ 第二次占位被拒', () => {
    expect(claimAskSlot('要不要改 uid 语义？', OPTS, 'q1', 'blk-7-q1')).toBe(true)
    // 第 8 轮把上一轮没拿到答案的 ask 原样重发：turn|blockId 变了，内容没变
    expect(claimAskSlot('要不要改 uid 语义？', OPTS, 'q1', 'blk-8-q1'), '同款未回答提问必须被拒').toBe(false)
    expect(openAskSlotCount(), '拒绝占位不应新增槽位').toBe(1)
  })

  it('换行/多空格差异不算新问题（签名先折叠空白）', () => {
    expect(claimAskSlot('要不要改 uid 语义？', OPTS)).toBe(true)
    expect(askSignature('要不要改 uid 语义？', OPTS)).toBe(askSignature('  要不要改 uid\n 语义？ ', OPTS))
    expect(claimAskSlot('  要不要改 uid\n 语义？ ', OPTS)).toBe(false)
  })

  it('选项变了 ⇒ 是真新问题，必须放行', () => {
    expect(claimAskSlot('要不要改 uid 语义？', OPTS)).toBe(true)
    expect(claimAskSlot('要不要改 uid 语义？', [{ id: 'x', label: '丙' }]), '换选项了不能算重复').toBe(true)
  })

  it('回答后立即释放：同内容提问再来时要能重新显示', () => {
    expect(claimAskSlot('选？', OPTS, 'q1', 'blk-7-q1')).toBe(true)
    answerAsk('q1', '甲')
    expect(claimAskSlot('选？', OPTS, 'q1', 'blk-9-q1'), '答完不释放 ⇒ 提问永不再可见').toBe(true)
  })

  it('被新提问取代（旧 promise 以 null 兑现）也释放旧槽位', async () => {
    // 模拟 handler 的两步：先占位（决定是否渲染），再绑 Promise
    expect(claimAskSlot('第一个问题', OPTS, 'q1', 'blk-1-q1')).toBe(true)
    const old = askUser({ question: '第一个问题', options: OPTS }, { askId: 'q1', cardKey: 'blk-1-q1' })
    expect(claimAskSlot('第二个问题', OPTS, 'q2', 'blk-2-q2')).toBe(true)
    void askUser({ question: '第二个问题', options: OPTS }, { askId: 'q2', cardKey: 'blk-2-q2' })
    await expect(old, '旧提问被取代后必须以 null 兑现').resolves.toBeNull()
    releaseAskSlot('q2')
    expect(openAskSlotCount(), '新旧提问都离场后不应残留占位').toBe(0)
  })
})

describe('一次提问只出一张卡（ask-single-card-v1）', () => {
  it('外部已建卡 ⇒ askUser 不再发第二张 ai:question 卡', () => {
    void askUser({ question: '选？', options: OPTS }, { askId: 'q1', cardKey: 'blk-7-q1' })
    expect(emitted.filter(e => e.kind === 'ai:question'), '块帧已渲染了提问卡，不应再造一张').toHaveLength(0)
    expect(askCardKeyOf('q1'), '登记的卡位置就是块帧卡').toBe('blk-7-q1')
  })

  it('默认路径（无外部卡片）仍照原样投递提问卡', () => {
    void askUser({ question: '选？', options: OPTS })
    const card = emitted.find(e => e.kind === 'ai:question')
    expect(card, '旧路径（非块帧提问）仍需自己建卡').toBeTruthy()
    expect(card?.updateKey).toBe(`askq-${String(card?.payload?.askId)}`)
  })

  it('回答更新打在**块帧卡**上，且答案真的兑现 Promise', async () => {
    const p = askUser({ question: '选？', options: OPTS }, { askId: 'q1', cardKey: 'blk-7-q1' })
    emitted.length = 0
    answerAsk('q1', '甲')
    const hit = emitted.find(e => e.kind === 'ai:question')
    expect(hit, '必须发出回答更新').toBeTruthy()
    expect(hit?.updateKey, '打在 askq- 上就更新不到 blk- 卡（答完仍像没反应）').toBe('blk-7-q1')
    expect(hit?.payload?.answered).toBe(true)
    expect(hit?.payload?.answer).toBe('甲')
    await expect(p).resolves.toBe('甲')
  })
})

// [WHY 源码级] 上面测的是纯函数能力；真正会不会被**调用**在这里。
//   少了调用点，能力再全也只是「库」，时间在悄悄刷屏。
describe('调用点承重', () => {
  it('handleBlockMsg 必须在 askUser + emit 之前做占位判断，且重复时整段 return', () => {
    const src = readSrc('packages/client/composables/ai/useAiReplyHandlers.ts')
    const fn = src.slice(src.indexOf('function handleBlockMsg'))
    const body = fn.slice(0, fn.indexOf('\n  }'))
    assert.match(
      body,
      /if \(!claimAskSlot\([\s\S]{0,160}\) return/,
      '缺 claimAskSlot 守卫：跨轮重发的同款提问会每轮多一张卡',
    )
    assert.match(
      body,
      /askUser\([\s\S]{0,160}\{ askId, cardKey: askCardKey \}/,
      'askUser 必须按外部卡片登记，否则同一提问出两张卡',
    )
    // [CONSTRAINT] return 必须早于 emitBus('ai:block'…)：只挡 askUser 不挡块帧 emit ⇒ 仍会多卡
    assert.ok(
      body.indexOf('claimAskSlot') < body.indexOf('emitBus(\'ai:block\''),
      '占位判断必须在尾部的 ai:block 投递之前',
    )
  })

  it('清空时间线必须同步释放提问占位（否则提问再也看不见）', () => {
    const src = readSrc('packages/client/composables/data/useWorkspaces.ts')
    assert.match(src, /import\('\.\.\/ui\/useAsk'\)/, '切工作区未接 resetAskSlots')
    assert.match(src, /resetAskSlots\(\)/, '切工作区必须真的调用 resetAskSlots')
  })
})
