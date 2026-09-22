// AIRUNNER-BATCH24-3-WEB-SERVER: web 侧测试（原 test/niumaBypass.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/niumaBypass.node-test.ts 迁至 test/niumaBypass.node-test.ts
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const AL = fs.readFileSync(path.join(ROOT, 'client/composables/ai/useAutoLoop.ts'), 'utf8')
const HD = fs.readFileSync(path.join(ROOT, 'client/composables/ai/auto-loop/handoff.ts'), 'utf8')
const W = fs.readFileSync(path.join(ROOT, 'client/composables/ai/useAiWaiting.ts'), 'utf8')

test('niuma: useAiWaiting 导出 niumaMode', () => {
  assert.match(W, /export\s+const\s+niumaMode\s*=/)
})

test('niuma: 无进展刹车旁路', () => {
  assert.ok(AL.includes('if (stall.stalled && !niumaMode.value)'))
})

test('niuma: 相同指纹刹车旁路', () => {
  assert.ok(AL.includes('if (fp.stalled && !niumaMode.value)'))
})

test('niuma: token 熔断旁路', () => {
  assert.ok(AL.includes('if (breakReason === \'token-budget\' && !niumaMode.value)'))
})

test('niuma: 单轮超时旁路', () => {
  assert.ok(AL.includes('if (!niumaMode.value) void finish(inst, \'round-timeout\''))
})

test('niuma: 宽容耗尽旁路', () => {
  assert.ok(AL.includes('if (decision.action === \'retry\' || niumaMode.value)'))
})

test('niuma: DONE 到达自动续推', () => {
  assert.ok(AL.includes('[niuma-done-continue]'))
  assert.ok(AL.includes('transport.sendFill(\'\', { prompt: \'继续工作\' })'))
})

test('niuma: hook 拒绝旁路', () => {
  assert.ok(AL.includes('[niuma-hook-keep]'))
})

test('niuma: 窗口丢失 3 处旁路', () => {
  assert.ok(AL.includes('[niuma-window-keep:首轮]'))
  assert.ok(AL.includes('[niuma-window-keep:multi]'))
  assert.ok(AL.includes('[niuma-window-keep:tolerance]'))
})

test('niuma: handoff 失败旁路', () => {
  assert.ok(HD.includes('[niuma-handoff-keep]'))
})

test('niuma: handoff.ts 引入 niumaMode', () => {
  assert.match(HD, /import\s*\{[^}]*\bniumaMode\b[^}]*\}\s*from\s*'\.\.\/useAiWaiting/)
})

test('niuma: finish 统一拦截存在', () => {
  assert.ok(AL.includes('[niuma-finish-keep]'))
  assert.ok(AL.includes('if (niumaMode.value && reason !== \'interrupted\')'))
})

test('niuma: finish 拦截联动 startWaiting', () => {
  assert.match(AL, /finish[\s\S]{0,900}startWaiting\(\)/)
})

test('niuma: useAiWaiting 导出模块级 startWaiting', () => {
  assert.match(W, /export\s+function\s+startWaiting/)
})

test('niuma: useAutoLoop 解构 startWaiting', () => {
  assert.match(AL, /const\s*\{[^}]*\bniumaMode\b[^}]*\}\s*=\s*useAiWaiting\(\)/)
  assert.match(AL, /const\s*\{[^}]*\bstartWaiting\b[^}]*\}\s*=\s*useAiWaiting\(\)/)
})

test('niuma: useAutoLoop 引入 useAiWaiting', () => {
  assert.ok(AL.includes('import { useAiWaiting } from \'./useAiWaiting.js\''))
})
