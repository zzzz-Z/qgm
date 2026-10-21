// [status-slot-inflow-v1] 阶段条必须「在流内占位」，不得回到贴底浮层。
// [WHY] 2026-10-21 用户截图：`AI 思考中` 条以 position:absolute 贴在 flow-timeline 底部，
//   正好盖住滚到该高度的消息正文（半透明 + blur 让下面那行字透出来，既看不清原文也读不了状态）。
//   修法是把状态条放进一条常驻、高度恒定的槽位（既不再遮挡，也不会因出现/消失撑动 DOM）。
//   这条判据钉住那个决定：一旦有人把 `.status-bar-inline` 改回 absolute / 底部定位，
//   或把槽位的高度改成随状态伸缩，本文件立刻变红。
// [CONSTRAINT] 只读源码文本，不跑浏览器布局——几何真值靠 tmp/status-slot-probe.mjs 实测
//   （list.bottom === slot.top，overlap 0px），这里守的是「结构不被改回去」。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VUE = path.join(CLIENT, 'components', 'script', 'TerminalPane.vue')
const SCSS = path.join(CLIENT, 'components', 'script', 'terminal-pane.scss')

const VUE_SRC = fs.readFileSync(VUE, 'utf8')
const SCSS_SRC = fs.readFileSync(SCSS, 'utf8')

/** 取单条选择器（选择器串逐字相等）的声明块内容 */
function ruleBody(src: string, selector: string): string {
  const re = new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm')
  const m = src.match(re)
  assert.ok(m, `找不到规则块：${selector}`)
  return m[1]
}

test('[status-slot-inflow-v1] 模板：状态条必须嵌在 .status-slot 里，而不是 flow-timeline 的直接子元素', () => {
  const m = VUE_SRC.match(/<div class="status-slot">([\s\S]*?)\n\s*<\/div>/)
  assert.ok(m, '模板里必须有 .status-slot 包裹层（槽位在流内占位，正是「不遮挡」的实现）')
  assert.match(m![1], /class="status-bar-inline"/, '按钮级的 status-bar-inline 必须在槽位内部')
  // 反向：flow-timeline 直接子层级出现裸的 status-bar-inline ⇒ 又变回覆盖层
  const bare = /<\/div>\s*<!--[^]*?-->\s*<div\s+v-if="runtimeKind === 'waiting'[^>]*class="status-bar-inline"/
  assert.doesNotMatch(VUE_SRC, bare, '.status-bar-inline 不得再作为 flow-timeline 的直接子元素')
})

test('[status-slot-inflow-v1] 样式：槽位常驻且高度恒定，条本体不再浮层定位', () => {
  const slot = ruleBody(SCSS_SRC, '.status-slot')
  assert.match(slot, /flex:\s*0\s+0\s+auto/, '槽位必须是不伸缩的固定项，否则 chat-list 会把它压没')
  const minH = slot.match(/min-height:\s*(\d+)px/)
  assert.ok(minH, '槽位必须有显式 min-height：高度随状态伸缩就回到「内容一到就上下晃」')
  assert.ok(Number(minH![1]) >= 40, `槽位高度 ${minH![1]}px 容不下 38px 高的状态条，会出现裁切`)

  const bar = ruleBody(SCSS_SRC, '.status-bar-inline')
  assert.doesNotMatch(bar, /position:\s*absolute/, '状态条不得再用 absolute 覆盖消息正文')
  assert.doesNotMatch(bar, /(?:^|\n)\s*(?:bottom|left|right):/, '状态条不得再用贴边偏移定位（那是浮层的写法）')
  assert.match(bar, /position|flex:\s*1\s+1\s+auto|width:\s*100%/, '状态条应由槽位控制尺寸，自身铺满槽位')
})

test('[status-slot-inflow-v1] 样式：消息区底部留白不得与槽位重复让位', () => {
  const list = ruleBody(SCSS_SRC, '.chat-list')
  const pad = list.match(/padding:\s*\d+px\s+\d+px\s+(\d+)px/)
  assert.ok(pad, '.chat-list 的 padding 简写形态变了，请同步更新本判据')
  assert.ok(
    Number(pad![1]) < 40,
    `chat-list 底部留白 ${pad![1]}px 是为浮层让位的历史值；槽位已在流内占位，再留这么多会变成双份空白`,
  )
})
