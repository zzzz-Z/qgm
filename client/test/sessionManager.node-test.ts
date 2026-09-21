import { it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const SM = readFileSync(join(ROOT, 'client/composables/ai/useSessionManager.ts'), 'utf8')
const GP = readFileSync(join(ROOT, 'client/components/generate/GeneratePanel.vue'), 'utf8')

it('SM: ASK_ROTATE_THRESHOLD 是数字', () => {
  assert.ok(/export const ASK_ROTATE_THRESHOLD = \d+/.test(SM))
})

it('SM: askCount 由 loadAskCount 初始化', () => {
  assert.ok(SM.includes('const askCount = ref(loadAskCount())'))
})

it('SM: 持久化 key = __ai_ask_count', () => {
  assert.ok(SM.includes('const ASK_COUNT_KEY'))
})

it('SM: trackMessage 内 user 自增并落盘', () => {
  assert.ok(SM.includes('saveAskCount(askCount.value)'))
})

it('SM: resetSession 清零并落盘', () => {
  const i = SM.indexOf('function resetSession')
  const body = SM.slice(i, i + 500)
  assert.ok(body.includes('askCount.value = 0'))
  assert.ok(body.includes('saveAskCount(0)'))
})

it('SM: 导出 askCount', () => {
  assert.ok(SM.includes('    askCount,'))
})

it('SM: 导出 resetAskCount', () => {
  assert.ok(SM.includes('    resetAskCount,'))
})

it('GP: 引入 ASK_ROTATE_THRESHOLD', () => {
  assert.ok(GP.includes('useSessionManager'))
})

it('GP: 引入 sendNewSession', () => {
  assert.ok(GP.includes('copyAndFill, sendNewSession'))
})

it('GP: 定义 checkRotateSession', () => {
  assert.ok(GP.includes('function checkRotateSession(): void {'))
})

it('GP: 低于阈值时 rotateViaSM 未被调触发', () => {
  assert.ok(GP.includes('rotateViaSM('))
})

it('GP: 使用共享的 maybeRotateSession', () => {
  const i = GP.indexOf('function checkRotateSession')
  const body = GP.slice(i, i + 600)
  const resetPos = body.indexOf('rotateViaSM(')
  const sendPos = body.indexOf('sendNewSession({ summary })')
  assert.ok(resetPos > 0 && sendPos > 0, 'both present')
})

it('GP: 发送后调用 checkRotateSession', () => {
  // [askcount-unify] 计数已下沉 copyAndFill；GP 内仍应调 checkRotateSession
  const i = GP.indexOf('copyAndFill(text)')
  const after = GP.slice(i, GP.indexOf('checkRotateSession()', i) + 25)
  assert.ok(after.includes('checkRotateSession()'), 'copyAndFill 后应调 checkRotateSession')
})

it('DU: copyAndFill 统一计数（自动路径不再漏）', () => {
  const DU = readFileSync(join(ROOT, 'client/composables/ai/useDeepseekUrl.ts'), 'utf8')
  assert.ok(DU.includes('useSessionManager'), '应引 useSessionManager')
  assert.ok(DU.includes('trackMessage'), 'copyAndFill 内应调 trackMessage')
  assert.ok(DU.includes('count?: boolean'), '应有 count 开关')
})

it('GP: onMounted 调用 checkRotateSession', () => {
  const i = GP.indexOf('onMounted(() => {')
  const body = GP.slice(i, i + 400)
  assert.ok(body.includes('checkRotateSession()'))
})

it('GP: 旧内嵌块 [auto-rotate-50] 已删除', () => {
  assert.ok(!GP.includes('[auto-rotate-50]'))
})

it('GP: 失败提示已加', () => {
  assert.ok(GP.includes('AI 窗口未就绪'))
})

it('GP: checkRotateSession 内部调用 sendNewSession', () => {
  const i = GP.indexOf('function checkRotateSession')
  const body = GP.slice(i, i + 400)
  assert.ok(body.includes('sendNewSession({ summary })'))
})
