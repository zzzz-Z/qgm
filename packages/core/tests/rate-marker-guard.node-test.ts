// [rate-retry-v1] 三处同构守卫：频控标记正则刻意内联在 3 处
// （headless 探测 detectReplyInPage / 发送验证 verifyFillSentInPage / 基线 resetReplyDedupInPage）
// ——headless 侧函数经 page.evaluate 序列化注入浏览器，不能引用模块级常量，故只能各写一份。
// 历史教训（limit 正则）：内联常量改一处漏一处 → 线上漏报，工作台干等超时。
// 本守卫断言：① inject 恰 1 处、inject-simple 恰 2 处且逐字符一致；② 覆盖真实/变体文案；③ 不误伤正文讨论。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()

const INJECT = 'packages/core/src/headless/headless-inject.ts'
const INJECT_SIMPLE = 'packages/core/src/headless/headless-fill.ts'

// [CONSTRAINT] 提取锚点：三处正则均为 /(?:消息|发送|操作|请求|访问)过于频繁 …… /gi 形式的字面量；锚点若变，本守卫须同步
const RE_LITERAL = /\/\(\?:消息\|发送\|操作\|请求\|访问\)过于频繁[\s\S]*?\/gi/g

function readLiterals(rel: string): string[] {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  return src.match(RE_LITERAL) || []
}

function injectLiteral(): string {
  const hits = readLiterals(INJECT)
  assert.equal(hits.length, 1, `${INJECT} 应恰有 1 处频控正则，实际命中 ${hits.length}`)
  return hits[0]
}

// [CONSTRAINT] 每次构造新实例：正则带 g 标志，复用同一实例会被 lastIndex 状态污染
function buildRe(): RegExp {
  const lit = injectLiteral()
  const m = lit.match(/^\/([\s\S]*)\/([a-z]*)$/)
  assert.ok(m, `正则字面量解析失败: ${lit.slice(0, 48)}`)
  return new RegExp(m[1], m[2])
}

test('rate marker parity: inject 1 处、inject-simple 2 处，三处逐字符一致', () => {
  const inject = injectLiteral()
  const simple = readLiterals(INJECT_SIMPLE)
  assert.equal(simple.length, 2, `${INJECT_SIMPLE} 应恰有 2 处频控正则（verifyFillSentInPage + resetReplyDedupInPage），实际命中 ${simple.length}`)
  assert.equal(simple[0], inject, 'verifyFillSentInPage 与 detectReplyInPage 频控正则不一致（内联常量分叉）')
  assert.equal(simple[1], inject, 'resetReplyDedupInPage 与 detectReplyInPage 频控正则不一致（内联常量分叉）')
})

test('rate marker: 覆盖 DeepSeek 真实文案与常见变体', () => {
  const re = buildRe()
  const samples = [
    '消息发送过于频繁，请稍后重试', // ← 线上真实频控文案
    '消息发送过于频繁',
    '发送过于频繁，请稍后重试',
    '操作过于频繁',
    '请求过于频繁，请稍后再试',
    'Please slow down',
    'Too Many Requests',
    'Rate limit exceeded, please try again later',
  ]
  for (const s of samples) {
    re.lastIndex = 0
    assert.ok(re.test(s), `应匹配却未匹配: ${s}`)
  }
})

test('rate marker: 不误伤正文讨论与普通「频繁」用词', () => {
  const re = buildRe()
  const samples = [
    '不要频繁地调用这个接口', // 无「过于频繁」名词连排
    '接口调用过于频繁会导致限流', // 「调用过于频繁」：名词不在白名单（消息/发送/操作/请求/访问）内
    '这篇文章更新得很频繁',
  ]
  for (const s of samples) {
    re.lastIndex = 0
    assert.ok(!re.test(s), `不应匹配却匹配: ${s}`)
  }
})
