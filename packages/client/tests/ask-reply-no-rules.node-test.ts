// [ask-reply-no-rules-v1] 承重：ASK 回答回传不得携带 SYSTEM.md 规则头。
// [WHY] 用户报告「本会话加载了两次 SYSTEM.md」：send.jsonl 实测两条首问块 24.1s 间隔；
//   根因是 ASK 回答路径（useAiReplyHandlers）未传 skipRules，去重键（sid:sessionId）被
//   resetSession / 窗口 sid 漂移击穿时，会把 SYSTEM.md + AGENTS.md 全文重拼进 ASK 回答。
//   与 exec-flow.ts 的 feedback-no-rules-v1 同一类修复：首问规则注入归 openAiSession(forceRules:true) 一处。
// [CONSTRAINT] 顺序判据而非行为判据——node 测试无 vue 上下文；但「是否写出 skipRules: true」是承重的：删掉即红。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'vitest'

function readSrc(): string {
  return readFileSync(
    new URL('../composables/ai/useAiReplyHandlers.ts', import.meta.url).pathname,
    'utf8',
  )
}

test('承重：ASK 回答 copyAndFill 必须传 skipRules: true（不重注入 SYSTEM.md）', () => {
  const src = readSrc()
  assert.match(
    src,
    /copyAndFill\(`【ASK 回答】[^`]*`,\s*\{\s*skipRules:\s*true\s*\}\)/,
    'ASK 回答未传 skipRules: true：去重键被 resetSession / 窗口 sid 漂移击穿时会把 SYSTEM.md 规则头混进回答（用户报告「两次加载 SYSTEM.md」的真实根因）',
  )
})
