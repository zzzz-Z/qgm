// [script-fence-gate-v1] 守卫：headless-inject.ts 与 tampermonkey 两处 decideScriptFence 必须逐例一致。
//
// 背景：第一层机器闸门（script-fence-gate）旨在把「SCRIPT 标记存在但从未推出有效 js 代码块」
//   从「静默降级成 plain 文本卡」变成「立即报 error」。该判定被抽成纯函数 decideScriptFence，
//   两份内联副本（浏览器注入 / 油猴备用通道）必须同构——改一处忘改另一处会让双通道行为分叉。
//
// 现统一为纯函数：返回 'report'（首次报 error）/ 'suppress'（已报过，抑制 plain 噪音）/ 'none'（不处理）。
// 本守卫把两处 decideScriptFence 的花括号内部抠出分别编译执行，对同一批样例真跑对拍；
//   同时断言期望值，防止「两处一起改错」。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import vm from 'node:vm'

const ROOT = process.cwd()
const SOURCES = [
  'packages/core/src/headless/headless-inject.ts',
  'scripts/tampermonkey-session-id.user.js',
]

/** 抠出 `function <name>(...) { <inner> }` 的花括号内部（与 reply-mark-parity 同款手法） */
function extractInner(src: string, name: string): string {
  const re = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)[^{]*\\{`)
  const m = re.exec(src)
  assert.ok(m, `未找到函数 ${name}`)
  const braceAt = m.index + m[0].length - 1
  let depth = 0
  for (let i = braceAt; i < src.length; i++) {
    const c = src[i]
    if (c === '{') { depth += 1
    }
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return src.slice(braceAt + 1, i)
    }
  }
  throw new Error(`${name} 花括号不配平`)
}

type Fence = (scriptMarkPositive: boolean, seenHashesLen: number, alreadyReported: boolean) => string

function build(rel: string): Fence {
  const inner = extractInner(fs.readFileSync(path.join(ROOT, rel), 'utf8'), 'decideScriptFence')
  return vm.runInNewContext(`(function (scriptMarkPositive, seenHashesLen, alreadyReported) { ${inner} })`, {}) as Fence
}

// [case, 描述, scriptMarkPositive, seenHashesLen, alreadyReported, 期望]
const CASES: [string, boolean, number, boolean, string][] = [
  ['非 SCRIPT 标记', false, 0, false, 'none'],
  ['已成功推过脚本（seenHashes>0）', true, 1, false, 'none'],
  ['首次违规（SCRIPT 且无有效块未报过）', true, 0, false, 'report'],
  ['已报过（抑制 plain 噪音）', true, 0, true, 'suppress'],
]

for (const [desc, a, b, c, expected] of CASES) {
  for (const src of SOURCES) {
    test(`decideScriptFence [${desc}] @ ${src} === ${expected}`, () => {
      assert.equal(build(src)(a, b, c), expected)
    })
  }
}

// 两通道一致性：同一批输入必须产出完全一致的输出
test('decideScriptFence 两通道输出完全一致', () => {
  const fns = SOURCES.map(build)
  for (const [, a, b, c] of CASES) {
    const outs = fns.map(f => f(a, b, c))
    assert.ok(outs.every(o => o === outs[0]), `输入(${a},${b},${c}) 两通道输出不一致: ${outs.join(' vs ')}`)
  }
})
