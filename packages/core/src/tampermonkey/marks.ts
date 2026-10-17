// @ts-nocheck
// [tampermonkey-ts-rewrite-v1] IIFE 物理切分片段，非独立模块；跨片段符号在单文件检查下不可见。
//   全部片段 TS 化完成、按拼回后的联合视图接线后再移除本 pragma。

/**
 * 回复标记扫描：`SCRIPT` / `ASK` / `DONE` / `HANDOFF` / `TEXT` 共用「首个非空行 = 独占标记行」判据。
 * [WHY] 早期各链路对「DONE」的形态理解不一致（有的要求首行严格等于，有的任意位置命中），
 *   同一条回复在不同通道被分到不同类别，甚至整轮丢失。统一后只认首行。
 * [CONSTRAINT] 正文里写「DONE 之后…」不会命中——这是有意为之，避免 AI 在解释时自触发。
 *   与 headless-inject.ts、packages/client/utils/reply-mark.ts 逐句同构，
 *   由 reply-mark-parity 守卫三处对拍；改一处必须同步三处。
 */

/** 标记名 → 该标记行的行号（1-based）；未命中为 -1 */
interface ReplyMarks {
  script: number
  ask: number
  done: number
  handoff: number
  text: number
}

function scanReplyMarks(md: string | null | undefined): ReplyMarks {
  const out: ReplyMarks = { script: -1, ask: -1, done: -1, handoff: -1, text: -1 }
  const lines = String(md || '').split(/\r?\n/)
  let head = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().length > 0) { head = i; break }
  }
  if (head < 0) return out
  const line = lines[head].trim()
  if (/^SCRIPT$/.test(line)) out.script = head + 1
  else if (/^ASK$/.test(line)) out.ask = head + 1
  else if (/^DONE$/.test(line)) out.done = head + 1
  else if (/^HANDOFF$/.test(line)) out.handoff = head + 1
  else if (/^TEXT$/.test(line)) out.text = head + 1
  return out
}
