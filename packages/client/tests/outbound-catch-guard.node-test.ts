// [outbound-catch-guard-v1] 用户可感知的发送函数不得出现「无留痕的空 catch」。
// [WHY] 停止 / 切换会话 / 新会话的静默失败在用户侧只表现为「点了没反应」，
//   而日志里没有任何线索（本次停止按钮失效即由 headlessSend 的裸 catch 放大）。
// [CONSTRAINT] 只约束发送路径；订阅者回调隔离等正当场景不在判据内。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'vitest'

const src = readFileSync(new URL('../composables/ai/useAiWindowSend.ts', import.meta.url), 'utf8')
const GUARDED = ['sendStopToImpl', 'sendRotateToImpl', 'sendNewSessionToImpl', 'headlessSend']

/** 取函数体（从签名行到下一个顶层 }） */
function bodyOf(name: string): string {
  const start = src.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `${name} 必须存在`)
  const open = src.indexOf('{', start)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') { depth++
    }
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  throw new Error(`${name} 函数体未闭合`)
}

describe('outbound 发送函数不得静默吞错', () => {
  for (const name of GUARDED) {
    it(`${name} 的 catch 必须带留痕`, () => {
      const body = bodyOf(name)
      const bare = body.match(/catch\s*\{\s*(?:\/\*[^*]*\*\/\s*)?return false\s*\}/g) || []
      assert.equal(bare.length, 0, `${name} 存在无留痕的空 catch: ${bare.join(' | ')}`)
    })
  }
})
