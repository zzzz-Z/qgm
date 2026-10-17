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
  var hasScriptHead = deps.hasScriptHead
  var hasUnclosedStructureJs = deps.hasUnclosedStructureJs
  var hasExecutableContent = deps.hasExecutableContent
  var stillStreamingReply = deps.stillStreamingReply
  var latestAssistantRoot = deps.latestAssistantRoot
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
    hasScriptHead: (t: string) => /^#!\s*\/usr\/bin\/env\s+(?:node|bash)\b/m.test(t) || /^\s*\/\/\s*@desc\b/m.test(t) || /^\s*#\s*@desc\b/m.test(t),
    hasUnclosedStructureJs: (src: string) => {
      const stack: string[] = []
      let state = 'code'
      for (let i = 0; i < src.length; i++) {
        const ch = src[i]
        const nx = src[i + 1]
        if (state === 'line-comment') { if (ch === '\n' || ch === '\r') state = 'code'; continue }
        if (state === 'block-comment') { if (ch === '*' && nx === '/') { state = 'code'; i++ } continue }
        if (state === 'single' || state === 'double' || state === 'template') {
          const q = state === 'single' ? '\'' : state === 'double' ? '"' : '`'
          if (ch === '\\') { i++; continue }
          if (ch === q) state = 'code'
          continue
        }
        if (ch === '/' && nx === '/') { state = 'line-comment'; i++; continue }
        if (ch === '/' && nx === '*') { state = 'block-comment'; i++; continue }
        if (ch === '\'') { state = 'single'; continue }
        if (ch === '"') { state = 'double'; continue }
        if (ch === '`') { state = 'template'; continue }
        if (ch === '{' || ch === '(' || ch === '[') { stack.push(ch); continue }
        if (ch === '}' || ch === ')' || ch === ']') {
          const want = ch === '}' ? '{' : ch === ')' ? '(' : '['
          if (stack.length === 0 || stack[stack.length - 1] !== want) return true
          stack.pop()
        }
      }
      if (state === 'single' || state === 'double' || state === 'template' || state === 'block-comment') return true
      return stack.length > 0
    },
    hasExecutableContent: (src: string) => String(src || '').split('\n').map(l => l.trim()).filter((l) => {
      if (!l) return false
      if (l.startsWith('#!')) return false
      if (l.startsWith('//')) return false
      if (l.startsWith('#')) return false
      return true
    }).join('').length > 0,
    stillStreamingReply: () => {
      const body = String((doc && (doc as any).body && (doc as any).body.textContent) || '')
      const w = (win || {}) as Record<string, unknown>
      const gate = w.__aiRunnerClosureGate as { len: number, ticks: number } | undefined
      if (!gate || gate.len !== body.length) { w.__aiRunnerClosureGate = { len: body.length, ticks: 0 }; return true }
      gate.ticks++
      return gate.ticks < 3
    },
    codeTextOf: (el: { textContent?: string }) => String((el && el.textContent) || '').replace(/^\n+|\n+$/g, ''),
    // [no-root-no-reply-v1] 两处 extractLatestScript 现经容器取 <pre>（headless 直接查选择器、
    //   油猴走 latestAssistantRoot）；假 DOM 已实现 .ds-assistant-message-main-content 路径
    latestAssistantRoot: () => {
      const els = (doc as { querySelectorAll: (sel: string) => unknown[] }).querySelectorAll('.ds-assistant-message-main-content')
      return els.length > 0 ? els[els.length - 1] : null
    },
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

// ============ ①b 行为：内容门（非注释内容非空）============
// [script-content-gate-v1] 2026-10-07 22:18:14 实测：AI 流式中途只吐出 #! + @desc + @why + @plan 的头部，
//   括号闭合门对纯注释天然返回 false ⇒ 被判「完整」推送 → 前端跑一次空脚本，完整块到达后再跑一次。
//   本段守卫「只有头部注释的残缺块不得被推送」。

/** 只有头部注释的残缺块（AI 流式中途的中间态）：括号天然闭合，但无任何可执行语句 */
const HEADER_ONLY = '#! /usr/bin/env node\n// @desc 读文件\n// @why 取证\n// @plan 逐步'

for (const rel of SOURCES) {
  test(`content-gate: ${rel} 只有头部注释的残缺块不得被推送`, () => {
    const seen: string[] = []
    const { doc } = makeDoc([makePre(HEADER_ONLY, 'js')], 'h'.repeat(12))
    const pick = buildPicker(rel, seen, doc, {})
    for (let i = 0; i < 5; i++) {
      assert.equal(pick(), null, `第 ${i + 1} 次：只有头部注释（无可执行内容）不得被推送`)
    }
  })

  test(`content-gate: ${rel} 正常脚本（注释 + 代码）不受内容门影响`, () => {
    const seen: string[] = []
    const { doc } = makeDoc([makePre(CLOSED, 'js')], 'h'.repeat(12))
    const pick = buildPicker(rel, seen, doc, {})
    const got = pick()
    assert.ok(got, '含可执行语句的脚本必须放行（内容门不得误伤正常脚本）')
    assert.equal(got.code, CLOSED)
  })
}

// ============ ② 扫描器：两处内联副本逐字同构 + 与服务端判据语义一致 ============

test('closure-gate: 两处内联 hasUnclosedStructureJs 逐字同构', () => {
  const inner = SOURCES.map(rel => extractInner(read(rel), 'hasUnclosedStructureJs'))
  assert.equal(inner[0].replace(/[;\s'"]+/g, '').replace(/\\/g, ''), inner[1].replace(/[;\s'"]+/g, '').replace(/\\/g, ''), '两个通道的内联扫描器必须同构（忽略空白/分号：油猴侧是 tsc 转译产物）')
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
      /if \(stillStreamingReply\(\)\)\s*continue;?/.test(src),
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
    /closureRetryTimer = setTimeout\(\(\) => \{ closureRetryTimer = null; classifyAndPost\(\);? \}, 400\);?/.test(src),
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

test('content-gate: 两处内联 hasExecutableContent 逐字同构', () => {
  const inner = SOURCES.map(rel => extractInner(read(rel), 'hasExecutableContent'))
  assert.equal(inner[0].replace(/[;\s'"]+/g, '').replace(/\\/g, ''), inner[1].replace(/[;\s'"]+/g, '').replace(/\\/g, ''), '两个通道的内联内容门必须同构（忽略空白/分号：油猴侧是 tsc 转译产物）')
})

test('content-gate: 两处 extractLatestScript 都必须挂内容门', () => {
  for (const rel of SOURCES) {
    const src = read(rel)
    assert.ok(src.includes('function hasExecutableContent('), `${rel} 缺少内容门扫描器 → 纯注释头会被当完整脚本推送（22:18:14 实测成因）`)
    assert.ok(
      /if \(!hasExecutableContent\(text\)\)\s*continue;?/.test(src),
      `${rel} 的取块循环里没有内容门调用点 → 扫描器写了也没用（判据必须落在调用点上）`,
    )
  }
})

test('closure-gate: 油猴通道 fill/rotate 开新一轮时必须清掉门基线', () => {
  const src = read(TAMPERMONKEY_SRC)
  const hits = (src.match(/window\.__aiRunnerClosureGate = null/g) || []).length
  const roundCalls = (src.match(/resetRoundState\(\)/g) || []).length
  assert.ok(
    hits >= 1 && roundCalls >= 3,
    `油猴通道未在 fill / rotate 开新一轮时清门 ⇒ 上一轮 ticks=3 会带入新轮，首帧直接放行未闭合块（实测命中 ${hits} 次，期望 ≥ 2）`,
  )
})
// ============ ④ 生成中门（无头通道 parity）============
// [generating-gate-v1] 原判据是三层弱条件叠加（脚本块 2 帧同 hash + 结构闭合 + body 长度稳定）；
//   三者皆「必要不充分」却被当作充分条件 ⇒ AI 写完一个完整函数后停顿 >800ms（或进入思考期
//   body 长度不变 3 帧）即误推脚本。油猴通道有「停止按钮可见 ⇒ 一定在生成」的强门，无头通道缺。
//   [判据承重] 删掉门 / 挪到 seenHashes 去重之后 ⇒ 本用例必红。
test('generating-gate: 无头通道必须在推送路径前挂生成中门（parity 油猴 350ms+生成中门）', () => {
  const src = read(BROWSER_SRC)
  assert.ok(/function\s+isGeneratingInPage\s*\(/.test(src), 'headless 缺 isGeneratingInPage 探针（与 stopped 检测共用）')
  // 门的形态：script 分支内、清 _pendingScriptHash、return null
  assert.ok(
    /if\s*\(\s*script\s*&&\s*isGeneratingInPage\(\)\s*\)\s*\{[\s\S]{0,200}return null/.test(src),
    '无头通道未挂生成中门 → 流式停顿 >800ms 即误推脚本（本门是修复的承重判据）',
  )
  // 位置断言：门必须在 seenHashes 去重判断之前（先拦生成中，再看去重）
  const gateAt = src.search(/if\s*\(\s*script\s*&&\s*isGeneratingInPage\(\)/)
  const seenAt = src.indexOf('if (script && !dedup.seenHashes.includes(script.hash))')
  assert.ok(gateAt >= 0, '找不到生成中门调用点')
  assert.ok(seenAt > gateAt, '生成中门必须在 seenHashes 去重判断之前（否则已推过的脚本会绕过门）')
})
