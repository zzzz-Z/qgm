// @vitest-environment happy-dom
// [script-toast-removed-v1] 2026-10-09 用户指定：去掉「📥 脚本 · js · N 行 · desc」到达 toast。
// [WHY] 该提示与时间线里的同一脚本卡片完全重复；长循环下每个脚本弹一次，抢走屏幕中央注意力。
// 承重方向（两条都要）：
//   ① 把到达 toast 加回去 ⇒ 用例 1/3 变红；
//   ② 顺手把「停止后不自动执行」这类**异常态**提示一起删掉 ⇒ 用例 2 变红（那是用户要动手的信号，不许误删）。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { beforeEach, expect, test, vi } from 'vitest'
import { ref } from 'vue'

import { PAGE_BOOT_TS, REFRESH_GUARD_MS, useAiReplyHandlers } from '../composables/ai/useAiReplyHandlers.js'

const h = vi.hoisted(() => ({
  schedCalls: 0,
  pushCalls: [] as unknown[],
  toasts: [] as Array<{ msg: string, type: string }>,
}))

// [loop-consolidation-P3d] 删除 useAutoLoop mock：useAiReplyHandlers 已在 P2 摘除该依赖
vi.mock('../composables/ai/useAutoTakeover', () => ({
  useAutoTakeover: () => ({
    enabled: ref(false),
    disable: () => {},
    scheduleAutoRun: () => { h.schedCalls += 1 },
  }),
}))
vi.mock('../composables/runner/useScriptInbox', () => ({
  useScriptInbox: () => ({
    // 返回带 desc 的 item：这正是截图里那条 toast 的第二段文案来源
    push: (o: unknown) => {
      h.pushCalls.push(o)
      return { id: 'x', code: 'c', lang: 'js', site: '', hash: 'hh', desc: '读 models.ts + field-library.ts 全文；判定重复实现', why: '', ts: 0 }
    },
  }),
}))
vi.mock('../composables/runner/useRunner', () => ({
  useRunner: () => ({ running: ref(false), run: () => {} }),
  pushTerminalNotice: () => {},
}))
vi.mock('../composables/ui/useToast', () => ({
  useToast: () => ({
    toast: (msg: unknown, type?: unknown) => { h.toasts.push({ msg: String(msg), type: String(type ?? 'info') }) },
  }),
}))
vi.mock('../composables/ai/useAiSite', () => ({ useAiSite: () => ({ url: ref(''), setUrl: () => {}, modelId: ref('m'), MODELS: [] }) }))
vi.mock('../composables/ai/useAiWaiting', () => ({ useAiWaiting: () => ({ stopWaiting: () => {} }) }))
// [stop-resume-v1] copyAndFill 为本会话新增的自动续推调用点所需；no-op 化避免 stopped 分支 TypeError
vi.mock('../composables/ai/useAiWindow', () => ({ useAiWindow: () => ({ listWindows: () => [], getWindowBySid: () => null, copyAndFill: () => Promise.resolve() }) }))
vi.mock('../composables/ai/useAiTransport', () => ({ transportKind: ref('tampermonkey') }))
vi.mock('../composables/ui/useAppStorage', () => ({ activeSessionId: ref('s1') }))
vi.mock('../composables/ui/useEventStream', () => ({ emit: () => {}, takePendingAskKey: () => '' }))
vi.mock('../composables/ui/useAsk', () => ({ askUser: async () => '' }))

beforeEach(() => { h.schedCalls = 0; h.pushCalls.length = 0; h.toasts.length = 0 })

function mkHandlers() {
  return useAiReplyHandlers({ sessionHistory: ref([]), saveHistoryScoped: () => {}, addSessionToHistory: () => {}, isMockMode: () => true })
}
function fakeEvent() { return { origin: 'https://x', source: null } as unknown as MessageEvent }
function reply(payload: Record<string, unknown>) {
  mkHandlers().handleAiReply(payload, fakeEvent())
}

test('① 正常到达的脚本：只 push 一次，不弹任何 toast（到达提示已删）', () => {
  vi.useFakeTimers()
  vi.setSystemTime(PAGE_BOOT_TS + REFRESH_GUARD_MS + 1)
  reply({ type: 'ai-runner:reply', kind: 'script', code: '// @desc a\n// @why b', lang: 'js', sessionId: 's1' })
  expect(h.pushCalls.length).toBe(1)
  expect(h.toasts.length).toBe(0)
  vi.useRealTimers()
})

test('② 停止后残余脚本：异常态 warn 提示必须保留（只删重复播报，不删要动手的信号）', () => {
  vi.useFakeTimers()
  vi.setSystemTime(PAGE_BOOT_TS + REFRESH_GUARD_MS + 1)
  reply({ type: 'ai-runner:reply', kind: 'stopped', text: '', sessionId: 's1' })
  h.toasts.length = 0 // 丢掉「本轮不再等待」本身，只看脚本分支的提示
  reply({ type: 'ai-runner:reply', kind: 'script', code: '// @desc a', lang: 'js', sessionId: 's1' })
  expect(h.toasts.length).toBe(1)
  expect(h.toasts[0].type).toBe('warn')
  assert.ok(h.toasts[0].msg.includes('未自动执行'), `异常态提示被改写/删除：${h.toasts[0].msg}`)
  vi.useRealTimers()
})

test('③ 源码锚点：script 分支不得再出现「📥 脚本」字面量，且不留无主导入', () => {
  const src = readFileSync('packages/client/composables/ai/useAiReplyHandlers.ts', 'utf8')
  assert.ok(!src.includes('📥'), 'useAiReplyHandlers 重新加回了 📥 脚本到达 toast（[script-toast-removed-v1]）')
  assert.ok(!src.includes('TOAST_MEDIUM_SHORT'), '到达 toast 删除后仍留 TOAST_MEDIUM_SHORT 导入/引用')
})
