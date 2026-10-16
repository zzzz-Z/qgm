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
// [done-stable-gate-v1] DONE 分支的 2 帧稳定门双通道同构守卫。
// [WHY] DONE marker 是 hash(`done-head|${summary.slice(0,200)}`)；短内容时前 200 字随流式变化
//   ⇒ 去重失效 ⇒ 同一 DONE 被推 N 次（2026-10-17 用户实测：先推前两行，再推完整版）。
//   修法是给 DONE 分支加一层「body 签名连续 2 帧相同才推」的稳定门——与 script 分支的
//   `_pendingScriptHash` 同构。两条通道（headless-inject.ts / tampermonkey.user.js）必须逐字对齐。
// [判据承重] 删任一侧的稳定门、或把字段名改成另一侧没有的 ⇒ 本用例必红。
test('done-stable-gate: 两侧都有 _pendingDoneSig 字段声明', () => {
  for (const rel of [HEADLESS, USERSCRIPT]) {
    const src = read(rel)
    assert.ok(
      /_pendingDoneSig/.test(src),
      `${rel} 缺 _pendingDoneSig：DONE 无稳定门 ⇒ 短内容流式每帧推一次`,
    )
  }
})

test('done-stable-gate: 两侧门形态同构（if 不等 → 赋值 return，相等 → 清空推送）', () => {
  for (const rel of [HEADLESS, USERSCRIPT]) {
    const src = read(rel)
    // 第一帧：不等则赋值并 return（延迟）
    assert.ok(
      /if \(\w*_pendingDoneSig !== \w*_doneSig\)/.test(src) || /_pendingDoneSig !== _doneSig/.test(src),
      `${rel} 缺「首帧不等则延迟」的判定`,
    )
    assert.ok(
      /_pendingDoneSig = _doneSig/.test(src),
      `${rel} 缺「赋值 _pendingDoneSig = _doneSig」`,
    )
    assert.ok(
      /_pendingDoneSig = null/.test(src),
      `${rel} 缺「推送后清空 _pendingDoneSig」——不清会让下一轮 DONE 被误当同帧延迟`,
    )
  }
})
