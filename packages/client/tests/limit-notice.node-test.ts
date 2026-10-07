// [limit-toast-quote-v1] 触顶 toast 文案组装的行为判据。
// [WHY] 诉求是「页面没有触顶 banner 却弹 toast」，而页面侧上报的命中原文此前被丢弃 ⇒
//       必须先保证「命中串一定被带出来」，否则下一次误报仍无从定位（判据必须承重：
//       把 formatLimitToast 改成原样返回通用文案，本文件 4 条应红）。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { formatLimitToast, LIMIT_TOAST_GENERIC, normalizeLimitHit } from '../utils/limit-notice.js'

test('limit notice: 无命中串时退回通用文案', () => {
  assert.equal(formatLimitToast(undefined), LIMIT_TOAST_GENERIC)
  assert.equal(formatLimitToast(''), LIMIT_TOAST_GENERIC)
  assert.equal(formatLimitToast('   \n\t '), LIMIT_TOAST_GENERIC)
})

test('limit notice: 命中串等于通用文案（页面侧兜底值）时不加自指括号', () => {
  assert.equal(formatLimitToast('AI 会话已达长度上限'), LIMIT_TOAST_GENERIC)
})

test('limit notice: 命中原文必须被带出（定位误报源的唯一信息）', () => {
  const out = formatLimitToast('达到对话长度上限，请开启新对话')
  assert.ok(out.includes('页面命中：'), `toast 未带命中串: ${out}`)
  assert.ok(out.includes('达到对话长度上限'), `toast 未回显命中原文: ${out}`)
})

test('limit notice: 拼接待侧栏按钮的假命中形态能被如实回显', () => {
  // 探针实测形态：正文末尾「对话长度上限」直接接侧栏常驻按钮「开启新对话」→ 命中
  const out = formatLimitToast('本模型对话长度上限开启新对话')
  assert.ok(out.includes('本模型对话长度上限开启新对话'), `假命中形态未被回显: ${out}`)
})

test('limit notice: 长 run-on 文本折叠空白并截断，避免撑爆 toast', () => {
  const junk = `${'甲乙丙丁'.repeat(40)}  对话长度上限\n开启新对话`
  const out = formatLimitToast(junk)
  const shown = out.replace(`${LIMIT_TOAST_GENERIC}（页面命中：`, '').replace(/）$/, '')
  assert.equal(shown.length, 41, `截断后长度应为 40 + 省略号，实际 ${shown.length}`)
  assert.ok(shown.endsWith('…'), '截断应带省略号')
  assert.ok(!/\s{2,}|\n/.test(shown), '空白未折叠')
})

test('limit notice: normalizeLimitHit 折叠空白且容忍非字符串', () => {
  assert.equal(normalizeLimitHit(' a\n\n b '), 'a b')
  assert.equal(normalizeLimitHit(null), '')
  assert.equal(normalizeLimitHit(123), '123')
})
