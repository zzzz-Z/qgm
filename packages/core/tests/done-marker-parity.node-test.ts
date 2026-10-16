// [done-marker-no-len-v1] DONE marker 在无头探测与油猴通道两处必须同构，且不得掺 length。
// [WHY] 掺 length 时流式每帧长度变化 → 每次 hash 都不同 → 同一 DONE 被推成 N 张卡（用户实测三份）。
// [承重] 任一处改回 `${...slice(0,200)}|${...length}` → 用例必红。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const HEADLESS = 'packages/core/src/headless/headless-inject.ts'
const USERSCRIPT = 'scripts/tampermonkey-session-id.user.js'

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

test('done-marker: headless 使用 done-head|<200字>，不掺 length', () => {
  const src = read(HEADLESS)
  assert.ok(
    /hash32\(`done-head\|\$\{[^}]+\}`\)/.test(src),
    '未找到 done-head|<200> 形态：可能被回退成含 length 的旧形式',
  )
  assert.ok(
    !/hash32\(`done-head\|\$\{[^}]+\}\|\$\{[^}]+\}\.length`\)/.test(src),
    'headless 的 marker 掺了 length：流式每帧都会变新 marker',
  )
})

test('done-marker: userscript 使用 done-head|<200字>，不掺 length', () => {
  const src = read(USERSCRIPT)
  assert.ok(
    /hash32\(`done-head\|\$\{[^}]+\}`\)/.test(src),
    '未找到 done-head|<200> 形态：可能被回退成含 length 的旧形式',
  )
  assert.ok(
    !/hash32\(`done-head\|\$\{[^}]+\}\|\$\{[^}]+\}\.length`\)/.test(src),
    'userscript 的 marker 掺了 length：流式每帧都会变新 marker',
  )
})

test('userscript @version 不得停留在 1.9.1（userscript-version-bump-v1）', () => {
  const src = read(USERSCRIPT)
  const m = src.match(/@version\s+(\d+\.\d+\.\d+)/)
  assert.ok(m, '缺失 @version 字段')
  assert.notEqual(m![1], '1.9.1', '内容已改，@version 必须升（否则油猴不拉新脚本）')
})
