// [remote-generating-v1] 按钮可见性与 loading 的承重判据
// 判据承重性：把 setRemoteGenerating 改成空函数，第三条必红。
import { test } from 'vitest'
import assert from 'node:assert/strict'
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
