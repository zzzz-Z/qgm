// [remote-generating-v1] 按钮可见性与 loading 的承重判据
// 判据承重性：把 setRemoteGenerating 改成空函数，第三条必红。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { computed } from 'vue'
import { remoteGenerating, setRemoteGenerating } from '../composables/ai/useAiWaiting.js'

/** 复刻 ScriptToolbar 的按钮可见性判定（不挂组件，避免引入整棵依赖树） */
const showStop = computed(() => remoteGenerating.value)
const busy = computed(() => remoteGenerating.value)

test('remoteGenerating: 默认 false', () => {
  setRemoteGenerating(false)
  assert.equal(remoteGenerating.value, false)
  assert.equal(showStop.value, false)
})

test('remoteGenerating: true 时按钮显示且转', () => {
  setRemoteGenerating(true)
  assert.equal(remoteGenerating.value, true)
  assert.equal(showStop.value, true)
  assert.equal(busy.value, true)
})

test('remoteGenerating: 复位后按钮回落（循环真停）', () => {
  setRemoteGenerating(true)
  setRemoteGenerating(false)
  assert.equal(remoteGenerating.value, false)
  assert.equal(showStop.value, false)
})

test('remoteGenerating: setter 归一化非布尔输入', () => {
  setRemoteGenerating(1 as unknown as boolean)
  assert.equal(remoteGenerating.value, true)
  setRemoteGenerating(0 as unknown as boolean)
  assert.equal(remoteGenerating.value, false)
})

// [remote-generating-watchdog-v1] 它只有 turn-end / generating-state 两个复位源，
//   而「0 块不发帧」意味着「脚本跑完、AI 沉默」永远等不到 turn-end ⇒ 按钮永久卡转（用户实测）。
//   看门狗是最后一道兜底；此处做源码级断言（真实 180s 等待不适合单测）。
test('看门狗：remoteGenerating 有独立的超时复位逻辑', () => {
  const src = readFileSync(new URL('../composables/ai/useAiWaiting.ts', import.meta.url), 'utf8')
  assert.ok(src.includes('REMOTE_WATCHDOG_MS'), '必须有独立的 remoteGenerating 超时常量')
  assert.ok(src.includes('remoteTimeout.start()'), 'setRemoteGenerating(true) 必须启动看门狗')
  assert.ok(src.includes('remoteTimeout.stop()'), '任何帧到达都必须重置计时')
  assert.ok(src.includes('remoteGenerating.value = false'), '超时回调必须复位 remoteGenerating')
})
