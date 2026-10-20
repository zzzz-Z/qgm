// [headlesssend-alias-guard-v1] headlessSend 的别名表必须与 transport 接口暴露的方法名对账。
// [WHY] 原实现直接反射取 *Impl 后缀名，而 transport 只有短名 ⇒ headless 通道下
//   停止 / 填充 / 切换会话 / 新会话四类操作全部落空且静默吞掉，用户表现为「点停止无效」。
//   别名表是两套命名的唯一桥接点，漂移必须立刻变红。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'vitest'

const sendSrc = readFileSync(new URL('../composables/ai/useAiWindowSend.ts', import.meta.url), 'utf8')
const transportSrc = readFileSync(new URL('../composables/ai/useAiTransport.ts', import.meta.url), 'utf8')

describe('headlessSend 方法名桥接', () => {
  it('别名表的值必须是 transport 接口真实暴露的方法名', () => {
    const aliasBlock = sendSrc.match(/const HEADLESS_METHOD_ALIAS[^{]*\{([\s\S]*?)\n\}/)
    assert.ok(aliasBlock, 'HEADLESS_METHOD_ALIAS 表必须存在（否则 headless 反射必然落空）')
    const values = [...aliasBlock[1].matchAll(/\w+:\s*'(\w+)'/g)].map(m => m[1])
    assert.ok(values.length >= 4, `别名表应覆盖 fill/stop/rotate/newSession 四项，实际 ${values.length}`)
    const ifaceBlock = transportSrc.match(/export interface AiTransport[^{]*\{([\s\S]*?)\n\}/)
    assert.ok(ifaceBlock, 'AiTransport 接口必须存在')
    const ifaceNames = new Set([...ifaceBlock[1].matchAll(/^\s*(\w+)\??:/gm)].map(m => m[1]))
    for (const v of values) {
      assert.ok(ifaceNames.has(v), `别名表值 ${v} 不在 AiTransport 接口中（反射必然落空）`)
    }
  })

  it('方法缺失不得静默 swallow', () => {
    assert.ok(!/swallow: transport 未就绪 \/ 方法缺失/.test(sendSrc), '方法缺失必须 warn 留痕')
    assert.ok(/headless-orphan-warn-v1/.test(sendSrc), '缺失留痕标记 headless-orphan-warn-v1 必须存在')
  })
})
