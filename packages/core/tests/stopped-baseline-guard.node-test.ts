// [stopped-detect-v2] 三处同构守卫：「已停止」标记正则刻意内联在 3 处
// （headless 冷启动基线 detectReplyInPage 初始化 / 探测 detectReplyInPage 主判定 /
//   基线 resetReplyDedupInPage）——headless 侧函数经 page.evaluate 序列化注入浏览器，
// 不能引用模块级常量，故只能各写一份。
// 历史教训：冷启动基线硬编码 0 时，页面刷新后会话历史里的旧「已停止」角标会让首次 poll
// 误报 {kind:'stopped'}，循环被判 ai-stopped（线上表现为「探测一直已停止」）。
// 本守卫断言：① inject 恰 2 处、inject-simple 恰 1 处且逐字符一致；② 覆盖 DeepSeek 真实角标文案。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()

const INJECT = 'packages/core/src/headless/headless-inject.ts'
const INJECT_SIMPLE = 'packages/core/src/headless/headless-inject-simple.ts'

// [CONSTRAINT] 提取锚点：三处正则均为 /当前问题已停止|已停止生成|已停止回答/g 形式的字面量；锚点若变，本守卫须同步
const RE_LITERAL = /\/当前问题已停止\|已停止生成\|已停止回答\/g/g

function readLiterals(rel: string): string[] {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  return src.match(RE_LITERAL) || []
}

test('stopped marker parity: inject 2 处（冷启动基线 + 主判定）、inject-simple 1 处（reset），三处逐字符一致', () => {
  const inject = readLiterals(INJECT)
  assert.equal(inject.length, 2, `${INJECT} 应恰有 2 处「已停止」正则（冷启动基线 + detectReplyInPage 主判定），实际命中 ${inject.length}`)
  const simple = readLiterals(INJECT_SIMPLE)
  assert.equal(simple.length, 1, `${INJECT_SIMPLE} 应恰有 1 处「已停止」正则（resetReplyDedupInPage 基线），实际命中 ${simple.length}`)
  assert.equal(inject[0], inject[1], '冷启动基线与主判定的「已停止」正则不一致（内联常量分叉）')
  assert.equal(simple[0], inject[0], 'resetReplyDedupInPage 与 detectReplyInPage 的「已停止」正则不一致（内联常量分叉）')
})

test('stopped marker: 冷启动基线初始化紧邻 _stoppedReported 守卫之前（防误报的口径说明在位）', () => {
  const src = fs.readFileSync(path.join(ROOT, INJECT), 'utf8')
  assert.ok(
    src.includes('[stopped-detect-v2] 冷启动基线 = 当前存量标记数'),
    '冷启动基线注释缺失：下次改动者不知道为什么基线不能硬编码 0',
  )
  const coldIdx = src.indexOf('dedup._stoppedBaseline = (((document.body')
  const detectIdx = src.indexOf('const stopMessages = stopText.match(/当前问题已停止')
  assert.ok(coldIdx > 0, '冷启动基线初始化语句缺失')
  assert.ok(detectIdx > coldIdx, '主判定应在冷启动基线之后（否则初始化永远不会生效）')
  assert.ok(
    !src.includes('dedup._stoppedBaseline = 0'),
    '禁止把 _stoppedBaseline 硬编码回 0（会复发「探测一直已停止」）',
  )
})
