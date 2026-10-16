import { readFileSync } from 'node:fs'
import { describe, it } from 'vitest'
import assert from 'node:assert/strict'

// [session-boot-v1] AI 窗口 F5 重载 = 新 AI 上下文（历史里无 SYSTEM.md），
//   但 sessionStorage 去重集合 + 工作区 firstPromptSent 会命中 → 首问规则永久漏注入。
//   修复：油猴首发 session-id 带 boot:true，客户端消费后清去重集与工作区标记。
//   判据承重：删任一侧（发送 / 消费 / 清除）本条必变红。

const winSrc = () => readFileSync(new URL('../composables/ai/useAiWindow.ts', import.meta.url), 'utf8')
const handlerSrc = () => readFileSync(new URL('../composables/ai/useAiReplyHandlers.ts', import.meta.url), 'utf8')
const tmSrc = () => readFileSync(new URL('../../../scripts/tampermonkey-session-id.user.js', import.meta.url), 'utf8')

describe('session-boot-v1：AI 窗口重载后清规则去重（防首问漏带 SYSTEM.md）', () => {
  it('客户端必须导出 resetRulesForSessionBoot 并按窗口 sid 前缀清去重集', () => {
    const src = winSrc()
    assert.ok(/export function resetRulesForSessionBoot\(/.test(src), '未导出 resetRulesForSessionBoot')
    assert.ok(/k\.startsWith\(prefix\)/.test(src), '未按 <winSid>: 前缀匹配：会漏清或误清其他窗口')
    assert.ok(/persistRulesInjected\(\)/.test(src), '未持久化：刷新后去重集复活')
    // [CONSTRAINT] 工作区维度标记必须一并清，否则硬短路依然命中
    assert.ok(/setFirstPromptSent\(wsId, false\)/.test(src), '未清工作区首问标记：硬短路继续生效')
  })

  it('handleSessionIdUpdate 必须消费 boot 标记，且早于 frameSid early-return', () => {
    const src = handlerSrc()
    assert.ok(/resetRulesForSessionBoot, useAiWindow/.test(src), '未从 useAiWindow 导入 resetRulesForSessionBoot')
    assert.ok(/payload\.boot === true\) resetRulesForSessionBoot/.test(src), '未按 payload.boot 分流')
    // [承重] 位置：清规则与该窗口是否当前站点视图无关，必须在 frameSid early-return 之前
    const bootIdx = src.indexOf('payload.boot === true')
    const frameSidIdx = src.indexOf('const frameSid = String(payload.sessionId || \'\')', src.indexOf('function handleSessionIdUpdate'))
    assert.ok(bootIdx > 0 && frameSidIdx > bootIdx, 'boot 消费必须早于 frameSid early-return：多站点并行时其他窗口重载也要清规则')
  })

  it('油猴首发 session-id 必须携带 boot 标记，且 @version 已升', () => {
    const src = tmSrc()
    assert.ok(/_bootSent/.test(src), '缺少 _bootSent 状态位')
    assert.ok(/const _isBoot = !_bootSent/.test(src), '未按首次判定 boot')
    assert.ok(/boot: _isBoot/.test(src), 'post 载荷未携带 boot 字段')
    // [userscript-version-bump-v1] 内容改了不升版本号 ⇒ 更新链路形同虚设
    const m = src.match(/@version\s+(\d+\.\d+\.\d+)/)
    assert.ok(m && m[1] !== '1.9.0', `@version 未升（当前 ${m ? m[1] : 'unknown'}）：油猴不会拉新脚本`)
  })
})

describe('send-verify-failed-not-final-v1：长首问「已填字却报未送达」误报修复', () => {
  it('sendFillToAsync 必须把 send-verify-failed 归 unacked（而非 failed）', () => {
    const src = readFileSync(new URL('../composables/ai/useAiWindowSend.ts', import.meta.url), 'utf8')
    assert.ok(/send-verify-failed-not-final-v1/.test(src), '归并标记缺失')
    assert.ok(
      /_ackReason === 'send-verify-failed'[\s\S]{0,80}?finish\('unacked'\)/.test(src),
      'send-verify-failed 必须 finish(\'unacked\')：油猴已把文本填入输入框，属「已投递未确认」',
    )
    // 反例守卫：不能改为直接放行 sent（那会掩盖真失败）
    assert.ok(!/send-verify-failed'[\s\S]{0,80}?finish\('sent'\)/.test(src), '不得直接判 sent：会掩盖真失败')
  })
})
