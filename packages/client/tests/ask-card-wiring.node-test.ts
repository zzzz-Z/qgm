// @desc @ask 提问卡接线验证（源码级）：弹窗改对话流卡片后的四端契约
// @why 这是一次跨文件改造（parser → 事件流 → UI → 挂载点），行为级测试需 mock DOM/transport；
//      用源码扫描锁定四端符号，防重构时只删改其中一端（与 ask-wiring.node-test.ts 同思路）
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')

test('事件流：已声明 ai:question 类型', () => {
  const src = read('packages/client/composables/ui/event-stream.ts')
  assert.ok(src.includes('\'ai:question\''), 'EventKind 应含 ai:question')
})

test('useAsk：经事件流投递提问卡，并回写已回答态', () => {
  const src = read('packages/client/composables/ui/useAsk.ts')
  assert.ok(src.includes('emit(\'ai:question\''), '应 emit ai:question')
  assert.ok(src.includes('askId: id'), 'payload 应带 askId（供 UI 判活跃）')
  assert.ok(src.includes('answered: true'), 'resolveAsk 应回写 answered 态')
})

test('TerminalPane：渲染提问卡并接上 resolveAsk', () => {
  const src = read('packages/client/components/script/TerminalPane.vue')
  assert.ok(src.includes('card.type === \'question\''), '应有 question 渲染分支')
  assert.ok(src.includes('resolveAsk('), '提交应调用 resolveAsk')
  assert.ok(src.includes('normalizeAskOptions'), 'payload 选项应先收窄类型')
})

test('弹窗已拆除：AskDialog 组件与挂载点都不复存在', () => {
  assert.equal(
    fs.existsSync(path.join(ROOT, 'packages/client/components/feedback/AskDialog.vue')),
    false,
    'AskDialog.vue 应已删除',
  )
  const toastHost = read('packages/client/components/feedback/ToastHost.vue')
  // [CONSTRAINT] 只断言「无 import / 无挂载」——注释里提及历史文件名是允许的
  assert.ok(!/from\s+['"]\.\/AskDialog\.vue['"]/.test(toastHost), '不应再 import AskDialog')
  assert.ok(!/<AskDialog\b/.test(toastHost), '不应再挂载 AskDialog')
})

test('样式：提问卡样式已就位', () => {
  const scss = read('packages/client/components/script/terminal-pane.scss')
  assert.ok(scss.includes('.question-card'), '缺 .question-card')
  assert.ok(scss.includes('.question-opt'), '缺 .question-opt')
  assert.ok(scss.includes('.question-input'), '缺 .question-input')
})
