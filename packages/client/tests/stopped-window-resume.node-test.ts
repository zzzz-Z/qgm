// [resume-watchdog-v1] 自动续推必须挂看门狗：续推后长时间无真实回复要明确提示，不能静默干等。
// [WHY] 续推失败是静默的（回复被 stopped 抑制窗口吞掉 / 页面探针静默失效），
//   用户只看到页面不动，无法判断该等还是该手动继续。
// [承重] 删掉 armResumeWatchdog(sid) → 第一例必红；删掉解除调用 → 第二例必红。
// [CONSTRAINT] 不得用「续推时清抑制窗口」来修这个症状：那会放行停止前发出、
//   停止后才到达的残余脚本（stopped-no-autorun 的判据）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { describe, it } from 'vitest'

const SRC = () => fs.readFileSync(new URL('../composables/ai/useAiReplyHandlers.ts', import.meta.url), 'utf8')

function resumeBranch(): string {
  const s = SRC()
  // [resume-sid-align-v1] 续推决策改用窗口 sid（payload.sessionId 在 DeepSeek 恒空），
  const i = s.indexOf('const _d = decideOnStopped(_resumeSid)')
  assert.ok(i > 0, '未找到 decideOnStopped 调用点：结构已变，守卫需同步')
  const end = s.indexOf('kind === \'limit\'', i)
  return s.slice(i, end > 0 ? end : i + 1600)
}

describe('resume-watchdog-v1', () => {
  it('续推分支必须挂看门狗，且不得清 stopped 抑制窗口', () => {
    const body = resumeBranch()
    // [resume-sid-align-v1] 看门狗必须按窗口 sid 注册：arm/disarm 同源才不会漏解除
    assert.ok(!/stoppedAtBySid\.delete/.test(body), '不得清抑制窗口：会放行停止前发出的残余脚本')
  })

  it('收到任意非 stopped 回复必须解除看门狗', () => {
    const s = SRC()
    const i = s.indexOf('function handleAiReply')
    const body = s.slice(i, i + 900)
    assert.ok(/disarmResumeWatchdog\(/.test(body), '未解除看门狗：正常回复后仍会误报超时')
  })

  it('看门狗提示走 reply-toasts 收口，不直接调 toast', () => {
    const s = SRC()
    assert.ok(/notifyResumeTimeout/.test(s), '未使用 reply-toasts 的 notifyResumeTimeout')
    assert.ok(!/toast\(/.test(s), '不得直接调 toast：该文件已把 toast 收口到 reply-toasts（vitest 下 auto-import 不生效）')
  })
})
