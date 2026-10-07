// [limit-detect-v3] 三处同构守卫：会话触顶标记正则刻意内联在 3 个文件
// （headless 探测 / headless 基线 / 油猴脚本）——headless 侧函数经 page.evaluate 序列化注入浏览器，
// 不能引用模块级常量，故只能各写一份。
// 历史教训 ①（漏报）：内联常量改一处漏一处 → 线上漏报。本例即 DeepSeek 真实文案
// 「达到对话长度上限，请开启新对话」（动词在前语序）在 v1 正则中完全漏匹配，工作台持续干等超时。
// 历史教训 ②（误报，v3 收紧的动因，2026-10-07 实测）：v2 允许**裸标记**命中，而两处探针扫的都是
// **整页** `document.body.textContent`（含侧栏、消息正文、UI chrome），实测两类假命中成立：
//   - 正文自指：工作台自己的任务文案「定位"会话长度达到上限"toast 弹窗源…」作为 AI 回复落进页面 DOM，
//     命中分支 2（名词+长度+达到+上限）——探针实测 `会话长度达到上限` 命中。
//   - 侧栏拼接：分支 4 的「请」是 `请?` 可缺省，而 DeepSeek 侧栏常驻按钮就是「开启新对话」，
//     任意以「对话长度上限」结尾的文本与之相接即命中——探针实测 `本模型对话长度上限开启新对话` 命中。
// v3 收紧：中文触顶必须**自带动作子句**（`[，,：:]请?` 或 `请` + 开启/开始/新建/创建 + 新对话/新会话），
// 裸标记不再算触顶。代价是漏报面变大（真 banner 若无动作子句则漏）——取向：误报会诱发无谓的轮转新会话，
// 漏报只退化为一次超时，故宁可漏。英文分支不变（英文正文自指风险低且无对应动作子句）。
// 本守卫断言：① 三处逐字符一致；② 覆盖真实/变体文案（均带动作子句）；③ 不误伤侧栏常驻按钮、
// 正文讨论、正文自指与侧栏拼接形态。
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

// [CONSTRAINT] 提取锚点：三处正则均为 /(?:(?:达到 …… /gi 形式的字面量；锚点若变，本守卫须同步
const RE_LITERAL = /\/\(\?:\(\?:达到[\s\S]*?\/gi/g

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
    '对话长度已达上限，请开启新对话', // 名词在前的旧形式
    '对话长度已达上限，请新建一个新对话', // 动作子句带「一个」的形态
    '上下文过长，请开启新对话', // 名词+形容词型（无动词）
    '会话已达上限，请开启新会话', // 无「长度」的词序变体
    '对话长度超限，请开启新对话', // 「超限」分支
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

test('limit marker: 不误伤正文自指与侧栏拼接（2026-10-07 实测误报，v3 收紧的判据）', () => {
  const re = buildRe()
  const samples = [
    '会话长度达到上限', // 误报①：工作台自身任务文案的用词（名词+长度+达到+上限）
    '定位"会话长度达到上限"toast 弹窗源', // 误报①线上原句形态
    '本模型对话长度上限开启新对话', // 误报②：正文与侧栏常驻按钮在 textContent 里相接
    '当达到对话长度上限后应轮转新会话', // 正文讨论：无动作子句，不算页面 banner
  ]
  for (const s of samples) {
    re.lastIndex = 0
    assert.ok(!re.test(s), `不应匹配却匹配: ${s}`)
  }
})
