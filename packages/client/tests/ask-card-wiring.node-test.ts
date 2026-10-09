// @desc ASK 提问卡接线验证（源码级）：弹窗改对话流卡片后的四端契约
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

// [ui-p1-tests-cascade-v1] V9 拆分后：TerminalPane 产出 question 卡片数据，
// RoundCard 负责渲染与提交，断言须覆盖两端（原来只扫 TerminalPane）。
test('对话流：question 卡片从 TerminalPane 产出，由 RoundCard 渲染并接上 resolveAsk', () => {
  const tp = read('packages/client/components/script/TerminalPane.vue')
  assert.ok(tp.includes('ai:question'), 'TerminalPane 应消费 ai:question 事件')
  assert.ok(tp.includes('type: \'question\''), 'TerminalPane 应产出 question 类型卡片')
  assert.ok(tp.includes('normalizeAskOptions'), 'payload 选项应先收窄类型')

  const rc = read('packages/client/components/script/RoundCard.vue')
  assert.ok(rc.includes('card.type === \'question\''), 'RoundCard 应有 question 渲染分支')
  assert.ok(rc.includes('resolveAsk('), 'RoundCard 提交应调用 resolveAsk')
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

// [ask-full-v1] 提问类卡片默认展开全文（对标宿主智能体的提问呈现）：
//   折叠态只给 6 行 / 400 字符预览会导致「二、现状」类长方案被拦腰截断，用户无法在卡内读完再决策。
//   预览+折叠机制保留，但提问类（question / ask）初始态改为展开；text / done 中间过程卡不受影响。
test('提问类卡片默认展开全文：expanded 初始值 = 提问类型 && truncated', () => {
  const rc = read('packages/client/components/script/RoundCard.vue')
  assert.ok(
    /const expanded = ref\(\s*\(props\.card\.type === 'question' \|\| props\.card\.type === 'ask'\)\s*&& props\.card\.truncated,?\s*\)/.test(rc),
    'RoundCard 的 expanded 应初始化为「(question || ask) && truncated」——摘掉任一类型或改回 ref(false) 即红',
  )
})
