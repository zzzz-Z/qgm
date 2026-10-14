// [idle-wake-poll-v1] 承重：油猴脚本 350ms 防抖回调必须先把 observerDebounce 归 null。
// [WHY] 800ms 空转唤醒轮询的守卫是 if (observerDebounce) return（脚本内 [idle-wake-poll-v1] 段）。
//   若防抖回调不归 null，第一次 MutationObserver 触发后该变量被永久占位，
//   800ms 轮询从此恒早退 ⇒ 用户报告「DOM 静止后收不到脚本，滚动一下才回传」的真实根因。
// [CONSTRAINT] 与 genRetryTimer / closureRetryTimer 的「回调首行归 null」模式一致。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { it } from 'vitest'

const ROOT = process.cwd()
const USERSCRIPT_REL = 'scripts/tampermonkey-session-id.user.js'

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

it('油猴回传：350ms 防抖回调必须归 null observerDebounce，否则 800ms 轮询被永久短路', () => {
  const src = read(USERSCRIPT_REL)
  const at = src.indexOf('observerDebounce = setTimeout')
  assert.ok(at >= 0, '未找到 350ms 防抖挂点（observerDebounce = setTimeout）')
  const seg = src.slice(at, at + 220)
  assert.ok(
    seg.includes('observerDebounce = null'),
    '防抖回调未归 null：800ms 空转轮询的守卫 if (observerDebounce) return 会恒真 ⇒ DOM 静止后回传停摆（用户实测：滚动一下才收到）',
  )
})
