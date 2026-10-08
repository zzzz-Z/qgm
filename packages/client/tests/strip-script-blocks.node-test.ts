// [strip-script-blocks-v1-test] 剥离脚本围栏块的判据
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { stripScriptBlocks } from '../utils/strip-script-blocks.js'

/** 构造三反引号围栏块 */
function fence(body: string): string {
  const F = String.fromCharCode(96).repeat(3)
  return `${F}js\n${body}\n${F}`
}

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
