// [strip-script-blocks-v1-test] 剥离脚本围栏块的判据
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { stripScriptBlocks } from '../utils/strip-script-blocks.js'
import { scanReplyMarks } from '../utils/reply-mark.js'

/** 构造三反引号围栏块 */
function fence(body: string): string {
  const F = String.fromCharCode(96).repeat(3)
  return `${F}js\n${body}\n${F}`
}

// [strip-tool-mark-v1] 工具调用标记泄漏行必须丢弃：它在截断时以普通文本漏进正文，
// 前端原样渲染就是用户看到的乱码。判据承重——正则失效则此用例必红。
test('T-TOOL: 工具调用标记行被整行剥离，正文保留', () => {
  const t = ['正常正文第一行', '<||DSML||| calls>', '<||DSML||| invoke name="act">', '正常正文第二行'].join('\n')
  assert.equal(stripScriptBlocks(t), '正常正文第一行\n正常正文第二行')
})

test('T-TOOL: 纯标记残留 ⇒ 空串（不渲染空噪音卡）', () => {
  assert.equal(stripScriptBlocks('<||DSML||| calls>'), '')
})

test('T-TOOL: 散文里的竖线不受影响（不误吞）', () => {
  assert.equal(stripScriptBlocks('用 a || b 表示或运算'), '用 a || b 表示或运算')
})

test('S1: 含 shebang 的脚本围栏块被整体剥离 ⇒ 空串', () => {
  const t = fence('#! /usr/bin/env node\n// @why x\nconsole.log(1)')
  assert.equal(stripScriptBlocks(t), '')
})

test('S2: 含 @desc 的脚本围栏块被剥离（无 shebang 也算）', () => {
  const t = fence('// @desc 做某事\n// @why 因为\nconst a = 1')
  assert.equal(stripScriptBlocks(t), '')
})

test('S3: 普通代码示例（无脚本特征）原样保留', () => {
  const body = 'const a = 1\nconsole.log(a)'
  const t = fence(body)
  const out = stripScriptBlocks(t)
  assert.ok(out.includes('const a = 1'), '无脚本特征的围栏块不得剥离')
})

test('S4: 未闭合围栏原样保留（流式中间态，不误吞）', () => {
  const F = String.fromCharCode(96).repeat(3)
  const t = `${F}js\n#! /usr/bin/env node\nconsole.log(1)`
  const out = stripScriptBlocks(t)
  assert.ok(out.includes('console.log(1)'), '未闭合围栏不得剥离')
})

test('S5: 文本 + 脚本混合 ⇒ 只留文本', () => {
  const t = ['先说明一下：', '', fence('#! /usr/bin/env node\n// @why y\nconsole.log(1)'), '', '后记。'].join('\n')
  const out = stripScriptBlocks(t)
  assert.ok(out.includes('先说明一下'), '文本保留')
  assert.ok(out.includes('后记'), '文本保留')
  assert.ok(!out.includes('console.log'), '脚本正文被剥离')
})

// [no-fence-v1] 无围栏形态：DOM→Markdown 反推可能不还原围栏，脚本头行起剥到末尾
test('S7: 无围栏 · 脚本头行起全部剥离 ⇒ 只留说明', () => {
  const t = ['说明文字', '#! /usr/bin/env node', '// @desc x', 'console.log("NOISE_RAW")', '后记'].join('\n')
  const out = stripScriptBlocks(t)
  assert.ok(out.includes('说明文字'), '前置文本保留')
  assert.ok(!out.includes('NOISE_RAW'), '脚本正文被剥离')
  assert.ok(!out.includes('后记'), '脚本头之后的「后记」也属脚本正文（无围栏时无法区分）')
})

test('S8: 无围栏 · // @desc 触发剥离', () => {
  const t = ['正文', '// @desc 做某事', 'const a = 1'].join('\n')
  const out = stripScriptBlocks(t)
  assert.equal(out, '正文')
})

test('S9: 无围栏 · 普通文本无脚本头 ⇒ 原样保留', () => {
  const t = ['段落一', '段落二', '```js 之外的普通文本'].join('\n')
  assert.equal(stripScriptBlocks(t), t.trim())
})

// [noise-fenced-v1] 围栏行被站点按钮文字污染（截图实证：js复制下载+反引号）
test('S10: 围栏行被污染仍能剥离', () => {
  const F = String.fromCharCode(96).repeat(3)
  const t = ['说明', `js复制下载${F}`, '#! /usr/bin/env node', 'console.log("X")', F, '后记'].join('\n')
  const out = stripScriptBlocks(t)
  assert.ok(out.includes('说明'), '前置文本保留')
  assert.ok(!out.includes('console.log'), '脚本正文被剥离')
  assert.ok(!out.includes('js复制下载'), '污染行被剥离')
})

// [real-sample-v1] 截图实证的真实形态：围栏行 = 站点按钮文字 + 反引号
test('S11: 真实样本（js复制下载 + 反引号 起始，干净反引号 结尾）', () => {
  const F = String.fromCharCode(96).repeat(3)
  const NL = String.fromCharCode(10)
  const lines = [
    '收到——B 没修好。我上轮的 e2e 是「注入理想样本」，真实路径我没复现。',
    '',
    `最可能的根因：真实文本里没有围栏（extractReplyMd 从 DOM 反推时 <pre> 可能不还原成 ${F}），`,
    '而我的 stripScriptBlocks 依赖围栏。先读盘验证。',
    '',
    `js复制下载${F}`,
    '// @desc 读 extractReplyMd',
    '// @why 若真实文本无围栏',
    '// @mode: diff',
    '',
    '(async () => {',
    '  const r = __AI__.tryReadFile(\'x\')',
    '})()',
    F,
    '',
    '后记：以上。',
  ].join(NL)
  const out = stripScriptBlocks(lines)
  assert.ok(out.includes('收到——'), '前置说明保留')
  assert.ok(out.includes('后记'), '后记保留（在围栏块之后）')
  assert.ok(!out.includes('__AI__.tryReadFile'), '脚本正文被剥离')
  assert.ok(!out.includes('js复制下载'), '污染围栏行被剥离')
  assert.ok(!out.includes('// @desc'), '脚本头注释被剥离')
})

test('S6: 空输入 ⇒ 空串（不抛）', () => {
  assert.equal(stripScriptBlocks(''), '')
  assert.equal(stripScriptBlocks('   '), '')
})

// ---- [strip-mark-lines-v1] 裸标记行：纯脚本回复剥完必须为空，否则前端渲染出「SCRIPT」噪音卡 ----
test('T1: 纯脚本回复（SCRIPT 标记行 + N 个围栏块）⇒ 剥完为空 ⇒ 整卡跳过', () => {
  const t = [
    'SCRIPT',
    '',
    fence('#! /usr/bin/env node\n// @desc a\n// @why b\nconsole.log(1)'),
    '',
    'SCRIPT',
    '',
    fence('#! /usr/bin/env node\n// @desc c\n// @why d\nconsole.log(2)'),
  ].join('\n')
  assert.equal(stripScriptBlocks(t), '', '裸 SCRIPT 标记行必须被剥掉，否则只剩 "SCRIPT\\n\\nSCRIPT"')
})

test('T2: 标记行 + 正文混排 ⇒ 只剥标记行本身，正文保留', () => {
  const t = ['SCRIPT', '', '这是说明文字', '', fence('#! /usr/bin/env node\n// @desc x\nconsole.log(1)'), '', '后记'].join('\n')
  const out = stripScriptBlocks(t)
  assert.ok(out.includes('这是说明文字'), '正文保留')
  assert.ok(out.includes('后记'), '后记保留')
  assert.ok(!out.includes('SCRIPT'), '标记行不得残留')
})

// [mark-list-parity-v1] 承重 + 防漂移：标记清单从 reply-mark.ts 源码抠出逐个对拍。
//   [WHY] strip 里写死了五个词，将来给回复加第六个标记（比如 `PLAN`）而此处忘了同步，
//         噪音卡会复活且无人察觉 —— 本用例从 SSOT 源码取词，漏同步立刻变红。
test('T3: 标记清单与 reply-mark.ts 同源（源码里每个标记词都必须能剥）', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'packages', 'client', 'utils', 'reply-mark.ts'), 'utf8')
  const words = [...src.matchAll(/\/\^([A-Z]+)\$\//g)].map(m => m[1])
  assert.ok(words.length >= 5, `未从 reply-mark.ts 抠到标记词（抽到 ${words.length} 个），正则失配会让本用例变真空`)
  for (const w of words) {
    // 同一批词必须在 SSOT 侧确实是标记（否则这里抽到的是无关正则）
    const hit = scanReplyMarks(`${w}\n正文`)
    assert.ok(Object.values(hit).some(v => v > 0), `${w} 在 scanReplyMarks 中不被识别为标记`)
    assert.equal(stripScriptBlocks(`${w}\n正文`), '正文', `裸标记行 ${w} 未被剥离`)
  }
})

test('T4: 行内提到标记词不剥（避免误吞正文）', () => {
  const t = ['请在最后写一行 DONE 表示结束', 'SCRIPT 不是保留字。'].join('\n')
  assert.equal(stripScriptBlocks(t), t, '整行恰为标记才剥，行内出现不得剥')
})
