// [script-fence-guess-removed-v1] 旧「按围栏猜脚本」通道已彻底删除的守卫。
//
// [WHY] 本文件原先守护 extractLatestScript 的三道流式门（闭合 / 内容 / 生成中）。
//   该函数按 ```lang 围栏猜脚本，导致 AI 正文里的示例代码被真执行 —— 已整体删除。
//   门禁本身不是坏设计，但它服务的是「猜」；新架构脚本意图由 turn 信封 content[].type 决定，
//   块在 JSON 里一次性到达，不存在「流式半截块」问题，故门禁无宿主。
//
// [CONSTRAINT] 本文件改为守护「旧通道不复活」：一旦有人把围栏猜测加回来，这里必红。
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

/** 剥掉注释行，只留活代码（注释里提到旧函数名不算复活）。 */
function activeCode(src: string): string {
  return src.split(String.fromCharCode(10)).filter((l) => {
    const t = l.trim()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/**')
  }).join(String.fromCharCode(10))
}

test('removed: 两处均不再定义 extractLatestScript（旧围栏猜测通道）', () => {
  for (const rel of SOURCES) {
    const code = activeCode(read(rel))
    assert.ok(
      !/function\s+extractLatestScript\s*\(/.test(code),
      `${rel} 仍定义 extractLatestScript → 按围栏猜脚本的旧通道被复活`,
    )
  }
})

test('removed: 两处均不再调用 extractLatestScript / extractScriptFromMarkdown', () => {
  for (const rel of SOURCES) {
    const code = activeCode(read(rel))
    assert.ok(!/extractLatestScript\s*\(/.test(code), `${rel} 仍调用 extractLatestScript`)
    assert.ok(!/extractScriptFromMarkdown\s*\(/.test(code), `${rel} 仍调用 extractScriptFromMarkdown`)
  }
})

test('removed: 两处均不再有围栏语言白名单分支（围栏筛选逻辑的标志）', () => {
  for (const rel of SOURCES) {
    const code = activeCode(read(rel))
    assert.ok(
      !/if \(lang !== 'js' && lang !== 'bash'\)/.test(code),
      `${rel} 仍保留围栏语言白名单分支`,
    )
  }
})

test('kept: 信封通道仍在（脚本下发唯一路径）', () => {
  for (const rel of SOURCES) {
    const src = read(rel)
    assert.ok(
      /function\s+(?:readTurnBlocks|readTurnFromRoot)\s*\(/.test(src),
      `${rel} 缺少信封读取函数 → 脚本彻底下发不了`,
    )
  }
})

test('kept: 服务端闭合判据 hasUnclosedStructure 未受影响', async () => {
  const mod = await import('../src/post-run/script-check.js')
  assert.equal(typeof mod.hasUnclosedStructure, 'function')
  assert.equal(mod.hasUnclosedStructure('function a() {'), true)
  assert.equal(mod.hasUnclosedStructure('function a() {}'), false)
})
