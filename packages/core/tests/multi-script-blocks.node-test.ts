// [script-fence-guess-removed-v1] 旧「按围栏猜脚本」多块选取逻辑已彻底删除的守卫。
//
// [WHY] 本文件原先用假 DOM 逐块驱动 extractLatestScript，验证「逐块放行 / 标记块优先 / 已推块不再选」。
//   该函数按 ```lang 围栏猜脚本，导致 AI 正文里的示例代码被真执行 —— 已整体删除。
//   新架构下脚本意图由 turn 信封 content[].type 决定，一条回复的多个 script 块在 JSON 里一次性到达，
//   由 turn-emit 逐块发帧，不存在「在页面里挑哪一块」的问题。
//
// [CONSTRAINT] 保留 idle-wake-poll：DOM 静止后的轮询兜底是唤醒机制，与围栏猜测无关。
import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const BROWSER_SRC = 'packages/core/src/headless/headless-inject.ts'
const TAMPERMONKEY_SRC = 'scripts/tampermonkey-session-id.user.js'
const SOURCES = [BROWSER_SRC, TAMPERMONKEY_SRC]

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8')
}

/** 剥掉注释行，只留活代码。 */
function activeCode(src: string): string {
  const lines = src.split(String.fromCharCode(10))
  const kept: string[] = []
  for (const l of lines) {
    const t = l.trim()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/**')) continue
    kept.push(l)
  }
  return kept.join(String.fromCharCode(10))
}

test('removed: 两处均不再有多块选取逻辑（extractLatestScript 已删）', () => {
  for (const rel of SOURCES) {
    const code = activeCode(read(rel))
    assert.ok(!/extractLatestScript\s*\(/.test(code), `${rel} 仍定义或调用 extractLatestScript`)
    assert.ok(!/hasMoreUnseenBlocks\s*\(/.test(code), `${rel} 仍调用 hasMoreUnseenBlocks`)
  }
})

test('removed: 不再有「标记块优先 / 无标记兜底」的选取语义', () => {
  for (const rel of SOURCES) {
    const code = activeCode(read(rel))
    assert.ok(!/firstUnseenMarked/.test(code), `${rel} 仍保留 firstUnseenMarked 选取逻辑`)
  }
})

test('kept: 信封通道仍在（脚本下发的唯一路径）', () => {
  for (const rel of SOURCES) {
    const src = read(rel)
    assert.ok(/function\s+readTurn(Blocks|FromRoot)\s*\(/.test(src), `${rel} 缺少信封读取函数`)
  }
})

test('idle-wake-poll: 油猴通道必须有 DOM 静止后的轮询兜底', () => {
  const src = read(TAMPERMONKEY_SRC)
  assert.ok(src.includes('[idle-wake-poll-v1]'), '缺少轮询兜底')
  assert.ok(src.includes('document.hidden'), '缺 document.hidden 检查')
  assert.ok(src.includes('classifyAndPost'), 'setInterval 内必须调用 classifyAndPost')
})
