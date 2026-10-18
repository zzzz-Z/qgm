// [ask-dedup-v1] ASK 回复必须自带去重的守卫。
// [WHY] 2026-10-18 实测事故：同一条 ASK 回复在 22 秒内被推送 **23 次**，间隔 818ms（= tick 周期），
//   用户看到「同一段回复刷了十几遍」。根因是 `[ask-any-cycle-v1]` 刻意让 ASK 绕过
//   `_plainSentInCycle` 的「本轮只推一次」去重，而 ASK 分支自己没有任何去重，
//   `_stableCount >= 3` 只是最低稳定门槛（涨到 3 就永远通过）⇒ 稳定后每拍都推。
// [CONSTRAINT] 这条守卫必须咬住「ASK 分支内存在内容 hash 比较」，
//   只断言 `_askSentHash` 出现过是空的（初始化里也有）；只断言 ask 分支存在也是空的（事故原样就存在）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SRC = 'packages/core/src/headless/headless-inject.ts'
const src = fs.readFileSync(path.join(ROOT, SRC), 'utf8')

/** 抠出 `if (marks.ask > 0) { … }` 的块（按花括号配平） */
function askBlock(s: string): string {
  const at = s.indexOf('if (marks.ask > 0) {')
  if (at < 0) throw new Error('未找到 ASK 分支（结构变了，守卫需同步）')
  const open = s.indexOf('{', at)
  let depth = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++
    else if (s[i] === '}') {
      depth--
      if (depth === 0) return s.slice(open, i + 1)
    }
  }
  throw new Error('ASK 分支花括号未配平')
}

describe('[ask-dedup-v1] ASK 回复去重', () => {
  const ask = askBlock(src)

  it('ASK 分支内必须有内容 hash 比较（同内容只推一次）', () => {
    expect(ask).toMatch(/_askSentHash\s*===\s*askHash/)
    expect(ask).toMatch(/dedup\._askSentHash\s*=\s*askHash/)
  })

  it('禁止「无去重直接返回 extractReplyMd」的写法（2026-10-18 刷屏原样）', () => {
    // 事故写法：if (marks.ask > 0) { return { kind: 'plain', text: extractReplyMd(replyRoot) } }
    expect(ask).not.toMatch(/return\s*\{\s*kind:\s*'plain',\s*text:\s*extractReplyMd\(replyRoot\)\s*\}/)
  })

  it('去重键必须在 resetReplyDedupInPage 的对象字面量里初始化（否则跨轮残留会吞掉新一轮同样的 ASK）', () => {
    // resetReplyDedupInPage 实际定义在 headless-fill.ts（headless-inject.ts 只是 re-export）
    const fill = fs.readFileSync(path.join(ROOT, 'packages/core/src/headless/headless-fill.ts'), 'utf8')
    const reset = fill.slice(fill.indexOf('export function resetReplyDedupInPage'))
    expect(reset, '未找到 resetReplyDedupInPage 的对象重建（结构变了，守卫需同步）').toMatch(/window\.__aiRunnerDedup = \{/)
    expect(reset).toMatch(/_askSentHash:\s*''/)
  })

  it('ASK 仍然不受 _plainSentInCycle 约束（ask-any-cycle-v1 语义未回退）', () => {
    expect(src).toMatch(/if \(dedup\._plainSentInCycle && marks\.ask < 0\)/)
  })
})
