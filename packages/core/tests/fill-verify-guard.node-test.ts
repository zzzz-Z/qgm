// [fill-verify-v2] AGENDA-10 守卫：headless:fill 的「发送验证」。
// 背景：新建会话后首帧 .ds-message 计数恒为 0。「绝对数 > 0」判据在慢渲染 / 改版下必判失败，
// 连锁后果有两条且都静默：① withBackoff 重试整个 fill（重新填充 + 重新点击）= 重复发送（实测一次建出两条会话）；
// ② handleFill 见 ok=false 直接 return → 不启动 reply poll → 对方回复无人接收，整轮被丢弃。
// 本守卫不只看关键字：它把 verifyFillSentInPage 从源码里抠出来、注入 fake DOM 真跑，
// 断言「增量 + 输入框已清空」两条新判据成立，且原有保护（生成中 click 被忽略）不被削弱。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import vm from 'node:vm'

const ROOT = process.cwd()
const INJECT_SIMPLE = 'packages/core/src/headless/headless-inject-simple.ts'
const AI_HEADLESS = 'packages/core/src/headless/ai-headless.ts'
const ATTACH_WS = 'packages/core/src/server/attach-ws.ts'

const BASELINE_KEY = '__aiRunnerFillBaseline'

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

/** 从源码抠出 `export function <name>(...) { ... }` 的函数体（含参数列表），按花括号配平。 */
function extractFnBody(src: string, name: string): string {
  // 覆盖三种定义形态：`export function f(` / `async function f(` / 对象方法 `async f(`
  const forms = [
    new RegExp(`export\\s+async\\s+function\\s+${name}\\s*\\(`),
    new RegExp(`export\\s+function\\s+${name}\\s*\\(`),
    new RegExp(`async\\s+function\\s+${name}\\s*\\(`),
    new RegExp(`async\\s+${name}\\s*\\(`),
  ]
  let at = -1
  for (const re of forms) {
    const m = re.exec(src)
    if (m) { at = m.index; break }
  }
  assert.ok(at >= 0, `未找到函数 ${name}`)
  const parenAt = src.indexOf('(', at)
  // [site-adapter-v1] 从 parenAt 算括号深度，跳过默认值里的 `{}`（如 `cfg = {}`）
  let parenDepth = 0
  let sigEnd = -1
  for (let i = parenAt; i < src.length; i++) {
    if (src[i] === '(') parenDepth++
    else if (src[i] === ')') { parenDepth--; if (parenDepth === 0) { sigEnd = i; break } }
  }
  assert.ok(sigEnd > 0, `${name} 函数签名不闭合`)
  // 从签名闭合处之后找函数体的 `{`
  const braceAt = src.indexOf('{', sigEnd)
  assert.ok(braceAt > 0, `${name} 缺少函数体`)
  let depth = 0
  for (let i = braceAt; i < src.length; i++) {
    const c = src[i]
    if (c === '{') {
      depth += 1
    } else if (c === '}') {
      depth -= 1
      if (depth === 0) return src.slice(parenAt, i + 1)
    }
  }
  throw new Error(`${name} 花括号不配平`)
}

// ---- fake DOM：只覆盖被测函数真实用到的面 ----
interface FakeMsgEl { querySelector: (sel: string) => unknown }
interface FakeInputEl { tagName: string, value?: string, textContent?: string }
interface FakeDoc {
  querySelectorAll: (sel: string) => FakeMsgEl[]
  querySelector: (sel: string) => FakeInputEl | null
  body: { textContent: string }
}
interface VerifyResult { sent?: boolean, rateLimited?: boolean, reason?: string }
type VerifyFn = (cfg?: Record<string, unknown>) => VerifyResult

function userBubble(): FakeMsgEl {
  return { querySelector: () => null }
}
function assistantBubble(): FakeMsgEl {
  return { querySelector: (sel: string) => (sel === '.ds-assistant-message-main-content' ? {} : null) }
}

function makeDoc(opts: { msgs?: FakeMsgEl[], inputValue?: string | null, body?: string }): FakeDoc {
  const msgs = opts.msgs ?? []
  const input = opts.inputValue
  return {
    querySelectorAll: (sel: string) => (sel === '.ds-message' ? msgs : []),
    querySelector: (sel: string) => {
      if (input === null) return null
      if (sel.startsWith('textarea') || sel === '[contenteditable="true"]') {
        return { tagName: 'TEXTAREA', value: input ?? '', textContent: '' }
      }
      return null
    },
    body: { textContent: opts.body ?? '' },
  }
}

/** 编译出 verifyFillSentInPage 的**可执行**版本（源码即被测对象，改了源码这里立刻变红）。
 *  [site-adapter-v1] extractFnBody 返回 `(cfg = {}) { ... }`（从开括号开始，不含 function 关键字），
 *  所以 wrapper 拼成 `return function ${body}`。
 *  用字符串拼接而非模板字符串——body 内含正则字面量和 .source 属性，模板字符串会把 `` ` `` 和 `${` 当插值。 */
function buildVerify(): (doc: FakeDoc, win: Record<string, unknown>) => VerifyResult {
  const body = extractFnBody(read(INJECT_SIMPLE), 'verifyFillSentInPage')
  // 用 vm 而非 new Function：被测源码当数据处理，编译产物拿不到本测试的闭包与宿主作用域
  const wrapper = '(function (document, window) { return function ' + body + ' })'
  const factory = vm.runInNewContext(wrapper, {}) as (d: FakeDoc, w: Record<string, unknown>) => VerifyFn
  return (doc, win) => factory(doc, win)({}) as VerifyResult
}

// ============ 行为断言：真跑判据 ============

test('fill-verify: 新会话首帧（消息尚未渲染 + 输入框已清空）判为已发送', () => {
  const verify = buildVerify()
  // 场景：fillPromptInPage 刚记录基线 count=0；消息还没渲染出来；但输入框已被清空。
  const doc = makeDoc({ msgs: [], inputValue: '' })
  const r = verify(doc, { [BASELINE_KEY]: { count: 0 } })
  assert.equal(r.sent, true, '修复前此场景必判 false → 重复发送 + 回复被丢弃')
  assert.equal(r.rateLimited, false)
})

test('fill-verify: 生成中 click 被忽略（输入框仍留有原 prompt）仍判未发送', () => {
  const verify = buildVerify()
  // 场景：基线 3 条、仍是 3 条；输入框里还留着我刚要发的内容 → 发送确实没生效，应当重试。
  const doc = makeDoc({ msgs: [userBubble(), assistantBubble(), userBubble()], inputValue: '请回复一个 bash 代码块' })
  const r = verify(doc, { [BASELINE_KEY]: { count: 3 } })
  assert.equal(r.sent, false, '不得把「click 被静默忽略」误判为已发送（原保护语义须保留）')
})

test('fill-verify: 增量成立且末条为用户气泡 → 已发送（兼容旧语义）', () => {
  const verify = buildVerify()
  const doc = makeDoc({ msgs: [userBubble(), assistantBubble(), userBubble()], inputValue: '残留' })
  const r = verify(doc, { [BASELINE_KEY]: { count: 2 } })
  assert.equal(r.sent, true)
})

test('fill-verify: 频控优先于「输入框已清空」弱信号，不得被掩盖', () => {
  const verify = buildVerify()
  const doc = makeDoc({
    msgs: [],
    inputValue: '',
    body: '消息发送过于频繁，请稍后重试',
  })
  const r = verify(doc, { [BASELINE_KEY]: { count: 0 } })
  assert.equal(r.sent, false, '被频控拒收时输入框也会被清空，不能据此反判为已发送')
  assert.equal(r.rateLimited, true)
  assert.ok(/频繁/.test(String(r.reason)), `应回传频控原文，实际: ${String(r.reason)}`)
})

test('fill-verify: 无基线时退回绝对数判据（不回归）', () => {
  const verify = buildVerify()
  const doc = makeDoc({ msgs: [userBubble()], inputValue: 'x' })
  const r = verify(doc, {})
  assert.equal(r.sent, true)
})

test('fill-verify: 末条为 AI 气泡时不得判为已发送', () => {
  const verify = buildVerify()
  const doc = makeDoc({ msgs: [userBubble(), assistantBubble()], inputValue: '' })
  const r = verify(doc, { [BASELINE_KEY]: { count: 1 } })
  assert.equal(r.sent, false)
})

// ============ 结构断言：三处修复缺一不可 ============

test('fill-verify: fillPromptInPage 必须记录发送基线', () => {
  const src = read(INJECT_SIMPLE)
  assert.ok(src.includes(BASELINE_KEY), `fillPromptInPage 未写 ${BASELINE_KEY}（增量判据缺基线，退化为绝对数判据）`)
  const body = extractFnBody(src, 'fillPromptInPage')
  assert.ok(body.includes(BASELINE_KEY), '基线必须在 fillPromptInPage 内写入（发送之前）')
})

test('fill-verify: ai-headless 必须走只读宽限轮询，不得再做单次定长采样', () => {
  const src = read(AI_HEADLESS)
  assert.ok(src.includes('verifyFillWithGrace'), '缺少 verifyFillWithGrace（仍是单次采样 → 首帧必判失败）')
  const body = extractFnBody(src, 'fillPrompt')
  assert.ok(body.includes('verifyFillWithGrace('), 'fillPrompt 必须调用 verifyFillWithGrace')
  assert.ok(!/setTimeout\(r2,\s*600\)/.test(body), 'fillPrompt 仍保留旧的 600ms 单次采样')
})

test('fill-verify: resetReplyDedup 必须在 fill 之前（reply-baseline-fix-v1）', () => {
  const src = read(ATTACH_WS)
  const body = extractFnBody(src, 'handleFill')
  // [reply-baseline-fix-v1] resetReplyDedup 记 `_baselineBlocks` / `_baselineLastHash` 作为本轮基线。
  //   若放在 fill 之后，DeepSeek 已渲染 AI 空回复块 ⇒ 基线含新块 ⇒ poll 判据恒真 ⇒
  //   前端收到 generating 后永远无 reply（无头静默丢回复）。故顺序守卫：reset 必须在 fill 之前。
  const atReset = body.indexOf('await pool.resetReplyDedup(sid)')
  const atFill = body.indexOf('await pool.fillPrompt(sid, prompt)')
  assert.ok(atReset >= 0, 'handleFill 缺少 resetReplyDedup 调用')
  assert.ok(atFill >= 0, 'handleFill 缺少 fillPrompt 调用')
  assert.ok(atReset < atFill, `resetReplyDedup 必须在 fillPrompt 之前（实际 reset@${atReset} fill@${atFill}）`)
})

test('fill-verify: fill 失败时 handleFill 不得提前 return（否则回复被静默丢弃）', () => {
  const src = read(ATTACH_WS)
  const body = extractFnBody(src, 'handleFill')
  const at = body.indexOf('if (!ok) {')
  assert.ok(at >= 0, 'handleFill 缺少 fill 失败分支')
  // 分支体内不得出现 return；只看代码，注释里说明性提到 return 不算
  const endOfBlock = body.indexOf('} else {', at)
  assert.ok(endOfBlock > at, 'fill 失败分支缺少 else 收尾')
  const between = body.slice(at, endOfBlock)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
  assert.ok(!/\breturn\b/.test(between), 'fill 失败分支内出现 return → reply poll 不会被启动')
  assert.ok(body.includes('startReplyPoll'), 'handleFill 必须启动 reply poll')
})
