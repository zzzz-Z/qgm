// [short-reply-gate-v1] 守卫：极短无标记回复不得被永久丢弃（无头链路真跑 detectReplyInPage）。
//
// 背景（2026-10-18 受控复现）：发「只回复两个字：收到」，页面 assistant 气泡就是「收到」，
//   body 铁定稳定（现场 poll-miss 130 tick、_stableCount=129、seenGrowth=true），却因旧闸门
//   「去空白 < 6 字 ⇒ return null」每 tick 命中，整轮静默丢回复，15s 后反过来告警「未收到任何回复」。
//
// [判据承重] 这里不抠函数体、不跑复制品：直接调用真实的 detectReplyInPage，桩出它读到的
//   window/document 面，逐 tick 断言返回值。删掉短回复出口、或让它重新恒返回 null，本用例立刻变红。
// [CONSTRAINT] headless-inject 是浏览器上下文代码；桩只需覆盖该函数真实读到的面
//   （querySelectorAll / body.textContent / cloneNode / MutationObserver），与 login-token-guard 同法。
import { beforeEach, describe, expect, it } from 'vitest'
import { detectReplyInPage } from '../src/headless/headless-inject.js'

type El = Record<string, unknown>

/** 助手气泡：textContent 是回复正文，内部无 pre/子块（可按需覆盖） */
function assistantBubble(text: string): El {
  return {
    nodeType: 1,
    tagName: 'DIV',
    className: '',
    textContent: text,
    childNodes: [],
    querySelectorAll: () => [],
    querySelector: () => null,
    closest: () => null,
  }
}

/** 停止按钮（生成中信号）：isGeneratingInPage 的标签通道据此判 true */
function stopButton(): El {
  return {
    disabled: false,
    textContent: '',
    getAttribute: (k: string) => (k === 'aria-label' ? '停止生成' : null),
  }
}

interface StubOpts { reply?: string, generating?: boolean }

/**
 * 桩浏览器环境。tick() 对应一次 poll（生产 800ms 一次），body 文本固定 ⇒ 每 tick bodySignature 相同。
 * 返回页面上当前是否仍「生成中」可由调用方切换（模拟「长回复首帧」→「生成结束」）。
 */
function stubEnv(opts: StubOpts = {}) {
  const reply = opts.reply ?? '收到'
  let generating = Boolean(opts.generating)
  const bubble = assistantBubble(reply)
  const bodyText = `侧栏 新对话 ${reply}`

  const doc = {
    body: {
      textContent: bodyText,
      cloneNode: () => ({ querySelectorAll: () => [], textContent: bodyText }),
    },
    querySelectorAll: (sel: string) => {
      if (sel.includes('.ds-assistant-message-main-content')) return [bubble]
      if (sel === '.ds-message') return [{ querySelector: () => null }, bubble]
      if (generating && sel.includes('button')) return [stopButton()]
      return []
    },
    querySelector: (sel: string) => {
      // isGeneratingInPage 的标签通道 scope 起点：输入框不存在 ⇒ scope=document（走全文档兜底）
      if (sel.includes('textarea') || sel.includes('contenteditable')) return null
      return null
    },
  }
  class MutationObserverStub { observe() { /* 桩：不触发，bodyVersion 恒定 */ } }

  const g = globalThis as unknown as Record<string, unknown>
  g.window = {}
  g.document = doc
  g.MutationObserver = MutationObserverStub
  return {
    setGenerating(v: boolean) { generating = v },
    /** 跑 n 次 poll，返回非 null 的结果序列 */
    run(n: number) {
      const hits: unknown[] = []
      for (let i = 0; i < n; i++) {
        const r = detectReplyInPage()
        if (r) hits.push(r)
      }
      return hits
    },
    dedup: () => (g.window as Record<string, unknown>).__aiRunnerDedup as Record<string, unknown>,
  }
}

describe('detectReplyInPage：极短回复（<6 字）', () => {
  beforeEach(() => { /* 每个用例自建环境 */ })

  it('「收到」稳定后必须交付 plain，且只交付一次', () => {
    const env = stubEnv({ reply: '收到' })
    const hits = env.run(12) as Array<{ kind: string, text: string }>
    expect(hits.length, '整轮 12 tick 内必须交付一次，否则就是静默丢回复').toBe(1)
    expect(hits[0].kind).toBe('plain')
    expect(hits[0].text).toBe('收到')
    // 后续 tick 不得重复推送同一张卡
    expect(env.dedup()._hitShortDup).toBeGreaterThan(0)
  })

  it('交付发生在静止窗满之后（≥7 tick），不在第 1 个稳定 tick 抢跑', () => {
    const env = stubEnv({ reply: '收到' })
    let firstHitAt = -1
    for (let i = 1; i <= 12 && firstHitAt < 0; i++) {
      if (detectReplyInPage()) firstHitAt = i
    }
    expect(firstHitAt).toBeGreaterThanOrEqual(7)
    expect(firstHitAt).toBeLessThanOrEqual(9)
  })

  it('生成中（停止按钮可见）不得交付「收到」——它可能只是长回复的首帧', () => {
    const env = stubEnv({ reply: '收到', generating: true })
    const hits = env.run(12)
    expect(hits.length, '生成中抢跑会把长回复切成两张卡').toBe(0)
  })

  it('生成本身结束后，同一条「收到」仍能交付', () => {
    const env = stubEnv({ reply: '收到', generating: true })
    env.run(10)
    env.setGenerating(false)
    const hits = env.run(10) as Array<{ kind: string, text: string }>
    expect(hits.length).toBe(1)
    expect(hits[0].text).toBe('收到')
  })

  it('正常长度回复不受影响（稳定 3 tick 即交付，不等短回复闸门）', () => {
    const env = stubEnv({ reply: '这是一个正常长度的回复，用于确认既有路径未被改动。' })
    let firstHitAt = -1
    for (let i = 1; i <= 10 && firstHitAt < 0; i++) {
      if (detectReplyInPage()) firstHitAt = i
    }
    expect(firstHitAt).toBeGreaterThan(0)
    expect(firstHitAt).toBeLessThanOrEqual(5)
  })
})
