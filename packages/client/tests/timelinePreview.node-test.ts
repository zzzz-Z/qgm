// [timeline-denoise-v1] 信息展示区降噪：预览截断纯函数的单测。
// [WHY] 折叠阈值是「用户看不看到完整内容」的判定依据，边界（恰好等于阈值 / 超长单行 /
//   上游已按字符截断）必须有断言守护，否则改动阈值时会静默改变用户可见信息量。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { clampTextPreview, denoiseLog, tailTextPreview } from '../../../packages/client/utils/timeline-preview'

/** 生成 n 行文本，每行 `L<i>` */
function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `L${i}`).join('\n')
}

// ============ clampTextPreview ============
test('clampTextPreview: 空串与空白输入 → totalLines 0', () => {
  for (const input of ['', '   ', '\n', '\n\n\n']) {
    const r = clampTextPreview(input)
    assert.equal(r.totalLines, 0, `输入 ${JSON.stringify(input)}`)
    assert.equal(r.preview, '')
    assert.equal(r.truncated, false)
    assert.equal(r.hiddenLines, 0)
  }
})

test('clampTextPreview: 短文本原样返回且不截断', () => {
  const r = clampTextPreview('hello\nworld')
  assert.equal(r.preview, 'hello\nworld')
  assert.equal(r.truncated, false)
  assert.equal(r.hiddenLines, 0)
  assert.equal(r.totalLines, 2)
})

test('clampTextPreview: 尾随换行与 CRLF 被归一化，不虚增行数', () => {
  const r = clampTextPreview('a\r\nb\r\n')
  assert.equal(r.totalLines, 2)
  assert.equal(r.preview, 'a\nb')
  assert.equal(r.truncated, false)
})

test('clampTextPreview: 行数恰好等于 maxLines → 不截断', () => {
  const r = clampTextPreview(lines(4), 4, 1000)
  assert.equal(r.totalLines, 4)
  assert.equal(r.truncated, false)
  assert.equal(r.hiddenLines, 0)
})

test('clampTextPreview: 行数超限 → 保留前 maxLines 行并报告省略行数', () => {
  const r = clampTextPreview(lines(15), 12, 1000)
  assert.equal(r.totalLines, 15)
  assert.equal(r.truncated, true)
  assert.equal(r.hiddenLines, 3)
  assert.equal(r.preview, lines(12))
})

test('clampTextPreview: 单行超长（压缩 JSON 类）→ 按字符截断，行数不虚报', () => {
  const long = 'x'.repeat(2000)
  const r = clampTextPreview(long, 12, 800)
  assert.equal(r.preview.length, 800)
  assert.equal(r.totalLines, 1)
  assert.equal(r.truncated, true)
  // 被截断的那一行仍算"保留"，省略行数为 0 —— 调用方据 truncated 显示展开入口
  assert.equal(r.hiddenLines, 0)
})

test('clampTextPreview: 多行中途触达字符上限 → 该行部分保留、其后整行计入省略', () => {
  const text = ['a'.repeat(300), 'b'.repeat(300), 'c'.repeat(300)].join('\n')
  const r = clampTextPreview(text, 12, 600)
  assert.equal(r.preview.length, 600)
  assert.equal(r.totalLines, 3)
  assert.equal(r.truncated, true)
  assert.equal(r.hiddenLines, 1)
  assert.equal(r.preview, `${'a'.repeat(300)}\n${'b'.repeat(299)}`)
})

test('clampTextPreview: 字符数与行数双阈值同时生效时取先到者', () => {
  const r = clampTextPreview(lines(50), 3, 5)
  assert.equal(r.truncated, true)
  assert.equal(r.preview, 'L0\nL1')
  assert.equal(r.hiddenLines, 48)
})

// ============ tailTextPreview ============
test('tailTextPreview: 空输入 → 空文本', () => {
  assert.deepEqual(tailTextPreview(''), { text: '', hiddenLines: 0 })
  assert.deepEqual(tailTextPreview('   '), { text: '', hiddenLines: 0 })
})

test('tailTextPreview: 行数未超限 → 全部保留且无省略', () => {
  const r = tailTextPreview('a\nb\nc', 5, 400)
  assert.equal(r.text, 'a\nb\nc')
  assert.equal(r.hiddenLines, 0)
})

test('tailTextPreview: 行数超限 → 只留尾部 keepLines 行并报告省略行数', () => {
  const r = tailTextPreview(lines(8), 5, 400)
  assert.equal(r.text, ['L3', 'L4', 'L5', 'L6', 'L7'].join('\n'))
  assert.equal(r.hiddenLines, 3)
})

test('tailTextPreview: 尾随换行不会造出一个空尾行', () => {
  const r = tailTextPreview(`a\nb\nc\n`, 5, 400)
  assert.equal(r.text, 'a\nb\nc')
  assert.equal(r.hiddenLines, 0)
})

test('tailTextPreview: 上游已按字符截断 → 丢弃残缺首行，并把它计入省略行数', () => {
  const head = 'x'.repeat(50)
  const raw = `${head}\ncmd ok\nexit 0`.padEnd(400, 'z')
  const r = tailTextPreview(raw, 5, 400)
  assert.equal(r.text.startsWith(head), false)
  assert.ok(r.text.startsWith('cmd ok'))
  // 残缺首行必须计入「省略 N 行」，否则文案会低报丢失内容
  assert.equal(r.hiddenLines, 1)
})

test('tailTextPreview: 单行输入即使触达字符上限也不丢行（否则会出现有输入却无预览）', () => {
  const raw = 'e'.repeat(400)
  const r = tailTextPreview(raw, 5, 400)
  assert.equal(r.text.length, 400)
  assert.equal(r.text, raw)
  assert.equal(r.hiddenLines, 0)
})

// ============ denoiseLog ============
test('denoiseLog: 纯空行被过滤（含连续空行）', () => {
  assert.equal(denoiseLog('a\n\n\nb'), 'a\nb')
  assert.equal(denoiseLog(''), '')
  assert.equal(denoiseLog('\n\n'), '')
})

test('denoiseLog: 纯分隔线被过滤', () => {
  assert.equal(denoiseLog('a\n---\nb'), 'a\nb')
  assert.equal(denoiseLog('a\n===\nb'), 'a\nb')
  assert.equal(denoiseLog('a\n###\nb'), 'a\nb')
  assert.equal(denoiseLog('a\n***\nb'), 'a\nb')
  assert.equal(denoiseLog('a\n___\nb'), 'a\nb')
})

test('denoiseLog: 连续重复行第 3 次起丢弃（保留前 2 次）', () => {
  const r = denoiseLog('x\nx\nx\nx')
  assert.equal(r, 'x\nx')
})

test('denoiseLog: 进度回退符残留（回车覆盖后的纯空白）被过滤', () => {
  const r = denoiseLog('a\n\r   \nb')
  assert.equal(r, 'a\nb')
})

test('denoiseLog: 保留缩进与内容行（不误删）', () => {
  const r = denoiseLog('  indented\npercent 50%\ncmd ok')
  assert.equal(r, '  indented\npercent 50%\ncmd ok')
})

test('denoiseLog: ANSI 转义被剥离（SGR 颜色 + 光标控制）', () => {
  const ESC = String.fromCharCode(27)
  const colored = `${ESC}[32mOK${ESC}[0m`
  assert.equal(denoiseLog(colored), 'OK')
  const multiline = `a${ESC}[31m` + `\n` + `b${ESC}[0m`
  assert.equal(denoiseLog(multiline), 'a\nb')
  // 非 ANSI 的普通方括号不受影响
  assert.equal(denoiseLog('[INFO] done'), '[INFO] done')
})

test('denoiseLog: 剥离行首 [AI] 前缀，保留内容', () => {
  assert.equal(denoiseLog('[AI] patched: true'), 'patched: true')
  assert.equal(denoiseLog('[AI] 剩余 @ask: 1'), '剩余 @ask: 1')
  // 纯 [AI] 行剥离后为空 → 丢弃
  assert.equal(denoiseLog('a\n[AI]\nb'), 'a\nb')
  // 非行首的 [AI] 不动
  assert.equal(denoiseLog('x [AI] y'), 'x [AI] y')
})
