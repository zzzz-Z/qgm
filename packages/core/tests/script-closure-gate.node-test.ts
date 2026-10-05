// [script-closure-gate-v1] 守卫：未闭合的代码块**不得**被当成完整脚本推送。
//
// 背景（应用端实测：「脚本尾部被截断」高频复现）：
//   在接收侧，「不把流式半截块推出去」此前只有一道**时间**屏障 ——
//   内置通道「连续 2 帧同 hash」（800ms 轮询）/ 油猴通道 350ms 防抖 + `isGenerating()` 门。
//   两者都只要求「这段时间内文本没变」，**都不要求块本身闭合**。于是：
//     ① 流式中途任何 ≥ 窗口的停顿都让半截块被判为完整；
//     ② 站点把回复切成「已停止」后「停止生成」按钮消失 ⇒ isGenerating() 转 false，
//        而代码块并未闭合，半截块被当作完整脚本 post 出去。
//   两条路径的后果同形：`/run` 报 `Unexpected end of input` + 结构未闭合 ⇒ 与上游 max_tokens
//   截断无法区分 ⇒ 应用端一律读成「脚本被截断」，反复拆小重发、白烧轮次。
//
// 本守卫做三件事（全部真跑，不用字符串存在性充当判据）：
//   ① 把两处 `extractLatestScript` 的**函数体**抠出来，喂可变的假 DOM 真跑，断言：
//      闭合块立即放行；未闭合块在「正文仍增长」时永不放行；正文静止满 CLOSURE_ACCEPT_TICKS 后放行（只延迟不丢弃）。
//   ② 抠出两处内联 `hasUnclosedStructureJs` 与**服务端判据** `hasUnclosedStructure` 做语料对拍
//      —— 两处内联副本必须逐字相同，且与服务端语义一致。
//   ③ 结构断言防回退（门被删改即红）。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import vm from 'node:vm'
// 服务端判据（packages/core/src/post-run/script-check.ts）—— 对拍的基准
import { hasUnclosedStructure } from '../src/post-run/script-check.js'

const BROWSER_SRC = 'packages/core/src/headless/headless-inject.ts'
const TAMPERMONKEY_SRC = 'scripts/tampermonkey-session-id.user.js'
/** 两处内联副本：page.evaluate 与用户脚本都无法共享模块 */
const SOURCES = [BROWSER_SRC, TAMPERMONKEY_SRC]

/** 正文静止多少帧后放行（与被测实现的 stillStreamingReply 常量一致；改一处必须同步另一处） */
const CLOSURE_ACCEPT_TICKS = 3

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8')
}

/** 抠出 `function <name>(...) { <inner> }` 的花括号内部（与 reply-mark-parity / multi-script-blocks 同构） */
function extractInner(src: string, name: string): string {
  const re = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)[^{]*\\{`)
  const m = re.exec(src)
  assert.ok(m, `未找到函数 ${name}`)
  const braceAt = m.index + m[0].length - 1
  let depth = 0
  for (let i = braceAt; i < src.length; i++) {
    const c = src[i]
    if (c === '{') {
      depth += 1
    } else if (c === '}') {
      depth -= 1
      if (depth === 0) return src.slice(braceAt + 1, i)
    }
  }
  throw new Error(`${name} 花括号不配平`)
}

interface Item { lang: string, code: string, hash: string }

/** 假 <pre>：可选 <code> 子元素（headless 走 code || pre，油猴走同一个 codeTextOf 口径） */
function makePre(code: string, cls: string): unknown {
  const codeEl = { className: cls, textContent: code }
  return { textContent: code, querySelector: (sel: string) => (sel === 'code' ? codeEl : null) }
}

/** 假 document：body.textContent 可变（充当「回复正文长度」信号） */
function makeDoc(pres: unknown[], bodyText: string): { doc: unknown, setBody: (t: string) => void } {
  const body = { textContent: bodyText }
  const root = { querySelectorAll: (sel: string) => (sel === 'pre' ? pres : []) }
  const doc = {
    body,
    querySelectorAll: (sel: string) => {
      if (sel === 'pre') return pres
      if (sel === '.ds-assistant-message-main-content') return [root]
      return []
    },
  }
  return { doc, setBody: (t: string) => { body.textContent = t } }
}

interface LiveSeen { includes: (h: string) => boolean, has: (h: string) => boolean }
function liveSeen(seen: string[]): LiveSeen {
  return { includes: (h: string) => seen.includes(h), has: (h: string) => seen.includes(h) }
}

/**
 * 用被测源码真跑一次 extractLatestScript
 * [CONSTRAINT] 额外注入 `window`：闭合门的挂点是 `window.__aiRunnerClosureGate`（两处通道共用，
 *   故意不走 dedup —— 这样才能保证两个文件里这段**逐字同构**）。
 *   hash32 用恒等函数，保证不同文本必得不同 hash（测试无需抗碰撞）。
 */
function buildPicker(rel: string, seen: string[], doc: unknown, win: Record<string, unknown>): () => Item | null {
  const inner = extractInner(read(rel), 'extractLatestScript')
  const body = `return function (deps) {
  var document = deps.document
  var window = deps.window
  var dedup = deps.dedup
  var seenHashes = deps.seenHashes
  var guessLangFromClass = deps.guessLangFromClass
  var guessLangFromDom = deps.guessLangFromDom
  var guessLangFromContent = deps.guessLangFromContent
  var hash32 = deps.hash32
  var codeTextOf = deps.codeTextOf
  function extractLatestScript() { ${inner} }
  return extractLatestScript()
}`
  const call = vm.runInNewContext(`(function () { ${body} })()`, {}) as (deps: unknown) => Item | null
  const deps = {
    document: doc,
    window: win,
    dedup: { seenHashes: liveSeen(seen), _preCache: new WeakMap() },
    seenHashes: liveSeen(seen),
    guessLangFromClass: (el: { className?: string }) => (el && el.className === 'js' ? 'js' : null),
    guessLangFromDom: () => null,
    guessLangFromContent: () => null,
    hash32: (s: string) => s,
    codeTextOf: (el: { textContent?: string }) => String((el && el.textContent) || '').replace(/^\n+|\n+$/g, ''),
  }
  return () => call(deps)
}

/** 设计上闭合的完整脚本（多行以满足「单行短块跳过」门槛） */
const CLOSED = '#! /usr/bin/env node\n// @desc 完整块\n// @why 闭合\nfunction f(a) {\n  return [a, (a + 1)]\n}\nconsole.log(f(1))'
/** 同一脚本被切断在尾部：少一个 `)` ⇒ 结构未闭合（与上游 max_tokens 截断后果同形） */
const UNCLOSED = '#! /usr/bin/env node\n// @desc 半截块\n// @why 截断\nfunction f(a) {\n  return [a, (a + 1)]'

// ============ ① 行为：闭合门 ============

for (const rel of SOURCES) {
  test(`closure-gate: ${rel} 闭合块立即放行（门不得误伤正常脚本）`, () => {
    const seen: string[] = []
    const { doc } = makeDoc([makePre(CLOSED, 'js')], 'x'.repeat(10))
    const pick = buildPicker(rel, seen, doc, {})
    const got = pick()
    assert.ok(got, '闭合块必须第一次就被放行（加门不得给正常脚本引入延迟）')
    assert.equal(got.code, CLOSED)
  })

  test(`closure-gate: ${rel} 未闭合 + 正文仍在增长 ⇒ 永不放行`, () => {
    const seen: string[] = []
    const { doc, setBody } = makeDoc([makePre(UNCLOSED, 'js')], 'a'.repeat(10))
    const pick = buildPicker(rel, seen, doc, {})
    for (let i = 0; i < 6; i++) {
      setBody('a'.repeat(10 + i * 7)) // 每次调用前正文都变长 = 仍在流式生成
      assert.equal(pick(), null, `第 ${i + 1} 次：正文还在增长，半截块不得被推送（这正是「脚本被截断」的接收侧成因）`)
    }
  })

  test(`closure-gate: ${rel} 未闭合 + 正文静止满 ${CLOSURE_ACCEPT_TICKS} 帧 ⇒ 放行（只延迟不丢弃）`, () => {
    const seen: string[] = []
    const { doc } = makeDoc([makePre(UNCLOSED, 'js')], 'b'.repeat(42))
    const pick = buildPicker(rel, seen, doc, {})
    // 第 1 次：记录基线（正文长度首次出现）⇒ 视为仍在增长 ⇒ 延迟
    for (let i = 0; i < CLOSURE_ACCEPT_TICKS; i++) {
      assert.equal(pick(), null, `第 ${i + 1} 次：正文尚未静止满 ${CLOSURE_ACCEPT_TICKS} 帧，应继续延迟`)
    }
    const got = pick()
    assert.ok(got, '正文静止满 N 帧仍未闭合 ⇒ 判定为上游真截断，必须放行（否则真截断会变成静默丢整轮）')
    assert.equal(got.code, UNCLOSED)
  })

  test(`closure-gate: ${rel} 正文长度回到旧值也要重新计时（防「静止」被误判）`, () => {
    const seen: string[] = []
    const { doc, setBody } = makeDoc([makePre(UNCLOSED, 'js')], 'c'.repeat(30))
    const pick = buildPicker(rel, seen, doc, {})
    assert.equal(pick(), null, '首次应延迟')
    setBody('c'.repeat(31))
    assert.equal(pick(), null, '正文长度变化 ⇒ 计时归零，应继续延迟')
    setBody('c'.repeat(30))
    assert.equal(pick(), null, '长度又变回旧值 ⇒ 仍视为「刚变化」，不得累计计数')
  })
}

// ============ ② 扫描器：两处内联副本逐字同构 + 与服务端判据语义一致 ============

test('closure-gate: 两处内联 hasUnclosedStructureJs 逐字同构', () => {
  const inner = SOURCES.map(rel => extractInner(read(rel), 'hasUnclosedStructureJs'))
  assert.equal(inner[0], inner[1], '两个通道的内联扫描器必须逐字相同（否则同一份回复走哪条通道结论不同）')
})

test('closure-gate: 内联扫描器与服务端 hasUnclosedStructure 语料对拍', () => {
  const inner = extractInner(read(BROWSER_SRC), 'hasUnclosedStructureJs')
  const fn = vm.runInNewContext(`(function () { function hasUnclosedStructureJs(src) { ${inner} } return hasUnclosedStructureJs })()`, {}) as (s: string) => boolean
  const corpus = [
    // —— 闭合 ——
    ['#! /usr/bin/env node\nconsole.log(1)', false],
    ['const a = 1\n// 行注释在文末是正常的', false],
    ['const a = [1, 2].map(x => (x * 2))\nconsole.log(a)', false],
    ['const s = "a(b[c"\nconsole.log(s)', false],
    // eslint-disable-next-line no-template-curly-in-string -- 这是**语料**：要测的正是模板插值形态的源码
    ['const t = `x${1}y`\nconsole.log(t)', false],
    ['/* 闭合块注释 */\nconst a = 1', false],
    ['const s = \'it\\\'s\'\nconsole.log(s)', false],
    // —— 未闭合（截断族）——
    ['const a = (\n', true],
    ['const s = \'abc', true],
    ['const t = `abc', true],
    ['/* 未闭合注释', true],
    ['const a = [1, 2\nconsole.log(a)', true],
    ['console.log(1))\n', true],
    // —— 扫描器识别不了的正则字面量（已知误报：只延迟不丢弃，见下一条用例）——
    ['const r = s.replace(/\\(/g, "")\nconsole.log(r)', true],
  ] as Array<[string, boolean]>
  for (const [src, want] of corpus) {
    const got = fn(src)
    const base = hasUnclosedStructure(src)
    assert.equal(got, want, `内联扫描器判 ${JSON.stringify(src.slice(0, 40))} 应为 ${want}`)
    assert.equal(base, want, `服务端 hasUnclosedStructure 判 ${JSON.stringify(src.slice(0, 40))} 应为 ${want}`)
  }
})

test('closure-gate: 正则误报的代价有界（延迟后仍放行，不得永久丢弃合法脚本）', () => {
  // 扫描器不认识正则字面量 ⇒ `/(/` 里的 `(` 被当成未闭合。这是**已知且可接受**的误报，
  // 前提是「只延迟不丢弃」：正文静止满 N 帧后照旧放行。
  const regexScript = '#! /usr/bin/env node\n// @desc 含正则\n// @why 误报样例\nconst r = s.replace(/\\(/g, "")\nconsole.log(r)'
  const seen: string[] = []
  const { doc } = makeDoc([makePre(regexScript, 'js')], 'd'.repeat(12))
  const pick = buildPicker(BROWSER_SRC, seen, doc, {})
  for (let i = 0; i < CLOSURE_ACCEPT_TICKS; i++) assert.equal(pick(), null, '延迟期内不放行')
  const got = pick()
  assert.ok(got, '合法脚本（含正则）在延迟后必须被放行 —— 否则门会把正常脚本永久吞掉')
  assert.equal(got.code, regexScript)
})

// ============ ③ 结构断言：门被删改即红 ============

test('closure-gate: 两处 extractLatestScript 都必须挂闭合门', () => {
  for (const rel of SOURCES) {
    const src = read(rel)
    assert.ok(src.includes('function hasUnclosedStructureJs('), `${rel} 缺少内联结构扫描器 → 半截块会被当完整脚本推送`)
    assert.ok(src.includes('function stillStreamingReply('), `${rel} 缺少「仍在生成」判据`)
    assert.ok(
      src.includes('if (hasUnclosedStructureJs(text)) {'),
      `${rel} 的取块循环里没有闭合门调用点 → 扫描器写了也没用（判据必须落在调用点上）`,
    )
    assert.ok(
      src.includes('if (stillStreamingReply()) continue'),
      `${rel} 的闭合门没有 continue ⇒ 未闭合块仍会被记为候选`,
    )
  }
})

test('closure-gate: 油猴通道必须为被延迟的块排复查（否则块永久滞留）', () => {
  const src = read(TAMPERMONKEY_SRC)
  assert.ok(src.includes('let closureRetryTimer = null'), '缺少单飞定时器声明')
  assert.ok(
    src.includes('closureGate.ticks < 3 && !closureRetryTimer'),
    '缺少「等待期内排一次复查」的判据 ⇒ 本通道只由 observer 唤醒，延迟后 DOM 静止则无人再叫它',
  )
  assert.ok(
    src.includes('closureRetryTimer = setTimeout(() => { closureRetryTimer = null; classifyAndPost() }, 400)'),
    '复查必须清空单飞标记并重跑分类，否则要么空转要么死锁',
  )
})

test('closure-gate: 内置通道的轮次重置必须清掉门基线', () => {
  const src = read('packages/core/src/headless/headless-inject-simple.ts')
  assert.ok(
    src.includes('window.__aiRunnerClosureGate = null'),
    'resetReplyDedupInPage 未清门 ⇒ 上一轮的长度基线会让新回复第一帧就被判「已静止」，未闭合块提前放行',
  )
})
