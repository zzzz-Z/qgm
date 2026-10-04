// [limit-detect-v2] 三处同构守卫：会话触顶标记正则刻意内联在 3 个文件
// （headless 探测 / headless 基线 / 油猴脚本）——headless 侧函数经 page.evaluate 序列化注入浏览器，
// 不能引用模块级常量，故只能各写一份。
// 历史教训：内联常量改一处漏一处 → 线上漏报。本例即 DeepSeek 真实文案
// 「达到对话长度上限，请开启新对话」（动词在前语序）在 v1 正则中完全漏匹配，工作台持续干等超时。
// 本守卫断言：① 三处逐字符一致；② 覆盖真实/变体文案；③ 不误伤侧栏常驻按钮与正文讨论。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()

const SOURCES = [
  'packages/core/src/headless/headless-inject.ts',
  'packages/core/src/headless/headless-inject-simple.ts',
  'scripts/tampermonkey-session-id.user.js',
]

// [CONSTRAINT] 提取锚点：三处正则均为 /(?:达到 …… /gi 形式的字面量；锚点若变，本守卫须同步
const RE_LITERAL = /\/\(\?:达到[\s\S]*?\/gi/g

function extractRegexes(): string[] {
  return SOURCES.map((rel) => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    const hits = src.match(RE_LITERAL) || []
    assert.equal(hits.length, 1, `${rel} 应恰有 1 处触顶正则，实际命中 ${hits.length}`)
    return hits[0]
  })
}

let cached: string | null = null
function limitLiteral(): string {
  if (cached === null) cached = extractRegexes()[0]
  return cached
}

// [CONSTRAINT] 每次构造新实例：正则带 g 标志，复用同一实例会被 lastIndex 状态污染
function buildRe(): RegExp {
  const lit = limitLiteral()
  const m = lit.match(/^\/([\s\S]*)\/([a-z]*)$/)
  assert.ok(m, `正则字面量解析失败: ${lit.slice(0, 48)}`)
  return new RegExp(m[1], m[2])
}

test('limit marker parity: 三处触顶正则逐字符一致', () => {
  const [a, b, c] = extractRegexes()
  assert.equal(b, a, 'headless-inject-simple 与 headless-inject 正则不一致（内联常量分叉）')
  assert.equal(c, a, 'userscript 与 headless-inject 正则不一致（内联常量分叉）')
})

test('limit marker: 覆盖 DeepSeek 真实文案与常见变体', () => {
  const re = buildRe()
  const samples = [
    '达到对话长度上限，请开启新对话', // ← 线上真实文案（动词在前）
    '达到对话长度上限',
    '对话长度已达上限，请开启新对话', // 名词在前的旧形式
    '对话已达上限',
    '上下文已达最大长度',
    '会话达到最大长度',
    '对话长度超限',
    'context length limit exceeded',
  ]
  for (const s of samples) {
    re.lastIndex = 0
    assert.ok(re.test(s), `应匹配却未匹配: ${s}`)
  }
})

test('limit marker: 不误伤侧栏常驻按钮与正文讨论', () => {
  const re = buildRe()
  const samples = [
    '开启新对话', // 侧栏常驻按钮：若命中会每轮误触发自动轮转
    '新建对话',
    '本对话长度上限是 128k token', // AI 正文讨论型
    '模型上下文窗口最大长度是 128k',
  ]
  for (const s of samples) {
    re.lastIndex = 0
    assert.ok(!re.test(s), `不应匹配却匹配: ${s}`)
  }
})
