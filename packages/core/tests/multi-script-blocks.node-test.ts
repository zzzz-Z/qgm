// [multi-script-v1] 守卫：一条 AI 回复携带多个脚本时，页面侧必须**逐块**放行而不是只取最后一块。
//
// 背景（用户实测）：应用端改多个文件时大量报「脚本被截断」。根因有两层——
//   ① 生成侧：网页 AI 单条回复受上游 max_tokens 上限，超出即被静默截断（脚本尾部缺失）；
//   ② 接收侧（本文件守护的）：`extractLatestScript` 是 `return lastMarked || last`，
//      一条回复里的多个脚本只有**最后一块**被执行，前面的块被**静默丢弃**；
//      而最后一块恰恰是截断最可能切中的那一块 → 整轮白跑、错误刷屏。
//
// 修法：改为「首个尚未推送」的块（优先取带脚本头契约标记的），由调用方的稳定判据逐块送出。
// 本守卫把两个文件（headless 注入 / 油猴通道）的 extractLatestScript **函数体**抠出来，
// 喂同一份假 DOM 真跑，断言逐块顺序与「标记优先」；并做结构断言防回退。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import vm from 'node:vm'

const BROWSER_SRC = 'packages/core/src/headless/headless-inject.ts'
const TAMPERMONKEY_SRC = 'scripts/tampermonkey-session-id.user.js'
/** 两处内联副本：page.evaluate 与用户脚本都无法共享模块（守卫同 reply-mark-parity） */
const SOURCES = [BROWSER_SRC, TAMPERMONKEY_SRC]

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8')
}

/** 抠出 `function <name>(...) { <inner> }` 的花括号内部（与 reply-mark-parity 同构） */
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

/** 假 DOM：一个 <pre> 节点（可选带 <code> 子元素） */
function makePre(code: string, cls: string): unknown {
  const codeEl = { className: cls, textContent: code }
  return {
    textContent: code,
    querySelector: (sel: string) => (sel === 'code' ? codeEl : null),
  }
}

/**
 * 假 DOM：document → 最后一条 assistant 容器 → 若干 <pre>
 * [CONSTRAINT] 两处实现的取值路径不同，必须同时满足：
 *   headless 走 `document.querySelectorAll('.ds-assistant-message-main-content')` → `root.querySelectorAll('pre')`；
 *   油猴通道直接 `document.querySelectorAll('pre')`（不分容器）。
 *   只实现其中一条会让另一个文件恒返回 null，测试静默变成「测了个空」。
 */
function makeDoc(pres: unknown[]): unknown {
  const root = { querySelectorAll: (sel: string) => (sel === 'pre' ? pres : []) }
  return {
    querySelectorAll: (sel: string) => {
      if (sel === 'pre') return pres
      if (sel === '.ds-assistant-message-main-content') return [root]
      return []
    },
  }
}

/**
 * 「已推送」集合的**活视图**（同一份数组同时支持两种取用方式）
 * [WHY] headless 用 `dedup.seenHashes.includes(h)`（数组），油猴用闭包 `seenHashes.has(h)`（Set）。
 *   若给 Set 传数组快照，测试里后续 push 不会反映到被测函数 → 「已推送不再参与选取」这条断言
 *   会变成永远为真的空断言（本次实现时实测踩到，故显式做成共享视图）。
 */
interface LiveSeen { includes: (h: string) => boolean, has: (h: string) => boolean }
function liveSeen(seen: string[]): LiveSeen {
  return {
    includes: (h: string) => seen.includes(h),
    has: (h: string) => seen.includes(h),
  }
}

/**
 * 用被测源码真跑一次 extractLatestScript
 * [CONSTRAINT] hash32 用恒等函数，保证不同文本一定得到不同 hash（测试里无需抗碰撞）
 */
function buildPicker(rel: string, seen: string[], doc: unknown, win: Record<string, unknown> = {}): () => Item | null {
  const inner = extractInner(read(rel), 'extractLatestScript')

  const body = `return function (deps) {
  var document = deps.document
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
    // headless 侧读 dedup.seenHashes + dedup._preCache（WeakMap）
    dedup: { seenHashes: liveSeen(seen), _preCache: new WeakMap() },
    // 油猴侧直接闭包引用 seenHashes
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
    // [no-root-no-reply-v1] 油猴侧 extractLatestScript 经 latestAssistantRoot() 取容器
    //   （假 DOM 已实现 .ds-assistant-message-main-content 路径，两条取值路径都能命中）
    latestAssistantRoot: () => {
      const els = (doc as { querySelectorAll: (sel: string) => unknown[] }).querySelectorAll('.ds-assistant-message-main-content')
      return els.length > 0 ? els[els.length - 1] : null
    },
  }
  return () => call(deps)
}

const B1 = '#! /usr/bin/env node\n// @desc 第 1 块\n// @why 多段执行\nconsole.log(1)'
const B2 = '#! /usr/bin/env node\n// @desc 第 2 块\n// @why 多段执行\nconsole.log(2)'
const B3 = '#! /usr/bin/env node\n// @desc 第 3 块\n// @why 多段执行\nconsole.log(3)'
/** 无 @desc / shebang 的 js 块（语言由 class 判定），用于验证「标记块优先」 */
const PLAIN_JS = 'const a = 1\nconst b = 2\nconsole.log(a + b)'

for (const rel of SOURCES) {
  test(`multi-script: ${rel} 逐块放行而不是只取最后一块`, () => {
    const seen: string[] = []
    const pick = buildPicker(rel, seen, makeDoc([makePre(B1, 'js'), makePre(B2, 'js'), makePre(B3, 'js')]))

    const first = pick()
    assert.ok(first, '第一块应被放行')
    assert.equal(first.code, B1, '应返回**首个**块（旧实现 lastMarked || last 会返回最后一块 → 回归）')
    seen.push(first.hash)

    const second = pick()
    assert.equal(second && second.code, B2, '推完第一块后应放行第二块')
    seen.push((second as Item).hash)

    const third = pick()
    assert.equal(third && third.code, B3, '推完第二块后应放行第三块')
    seen.push((third as Item).hash)

    assert.equal(pick(), null, '全部推送完毕后不得再返回任何块（否则会重复执行）')
  })

  test(`multi-script: ${rel} 标记块优先于无标记块`, () => {
    const seen: string[] = []
    // 顺序刻意「无标记块在前」：若实现退化为纯 firstUnseen，会先放行示例代码
    const pick = buildPicker(rel, seen, makeDoc([makePre(PLAIN_JS, 'js'), makePre(B2, 'js')]))
    const got = pick()
    assert.equal(got && got.code, B2, '带 @desc/shebang 的块应优先于无标记块（避免执行正文里的示例代码）')
  })

  test(`multi-script: ${rel} 已推送的块不再参与选取`, () => {
    const seen: string[] = []
    const pick = buildPicker(rel, seen, makeDoc([makePre(B1, 'js'), makePre(B2, 'js')]))
    const a = pick()
    seen.push((a as Item).hash)
    // 只把 B2 也标记为已推送 → 应返回 null，而不是又把 B1 交出来
    seen.push(B2)
    assert.equal(pick(), null, 'seenHashes 命中时必须跳过，否则「首个未见」会永远卡在同一块')
  })
}

// ============ [fragment-guard-v1] 混合回复片段不推（WO-20261007-03 段一） ============

// ============ [no-root-no-reply-v1] 无 assistant 容器时不得扫整页 ============
// [WHY] 新会话首轮「已思考/搜索」阶段页面上还没有 .ds-assistant-message-main-content，
//   旧实现（headless 兜底 document / 油猴直接扫 document.querySelectorAll('pre')）会把
//   用户首条消息里的代码块当脚本候选。判据承重：旧实现下本用例会返回 B1（红）。

for (const rel of SOURCES) {
  test(`no-root: ${rel} 无 assistant 容器时不把整页 pre 当脚本候选`, () => {
    // 假 DOM：有 <pre>，但**没有** .ds-assistant-message-main-content 容器
    const noRootDoc = {
      querySelectorAll: (sel: string) => (sel === 'pre' ? [makePre(B1, 'js')] : []),
    }
    const pick = buildPicker(rel, [], noRootDoc)
    assert.equal(pick(), null, '容器缺失时 extractLatestScript 必须返回 null，不得退回整页扫描')
  })
}

for (const rel of SOURCES) {
  test(`fragment-guard: ${rel} 有标记块时，无标记片段不推（用例 A）`, () => {
    const seen: string[] = []
    // 1 个标记块 + 2 个无标记片段（顺序：片段-标记-片段）
    const pick = buildPicker(rel, seen, makeDoc([makePre(PLAIN_JS, 'js'), makePre(B1, 'js'), makePre('const c = 3', 'js')]))
    const first = pick()
    assert.equal(first && first.code, B1, '标记块应被选中')
    seen.push((first as Item).hash)
    assert.equal(pick(), null, '本回复已有标记块 ⇒ 无标记片段不得再推（旧兜底会推 → 400 MISSING_DESC）')
  })

  test(`fragment-guard: ${rel} 整条回复无标记块时仍兜底（用例 B）`, () => {
    const seen: string[] = []
    const pick = buildPicker(rel, seen, makeDoc([makePre(PLAIN_JS, 'js')]))
    const got = pick()
    assert.equal(got && got.code, PLAIN_JS, '无任何标记块 ⇒ 保持兜底（AI 漏写头的自纠回路，不得禁掉）')
  })
}

// ============ 结构断言：不得退回「只取最后一块」 ============

test('multi-script: 两处实现都不得保留 lastMarked || last 的旧语义', () => {
  for (const rel of SOURCES) {
    const src = read(rel)
    assert.ok(
      !src.includes('return lastMarked || last'),
      `${rel} 仍是「取最后一块」→ 一条回复里的前序脚本会被静默丢弃（本次修复的核心回归点）`,
    )
    // [fragment-guard-v1] 语义已收紧：存在任意标记块时，无标记块视为片段不推（WO-20261007-03 段一）。
    // 守意图：不得退回「无条件兜底 firstUnseen」——那会把说明性片段当脚本推。
    assert.ok(
      /if \(firstUnseenMarked\)\s*return firstUnseenMarked;?/.test(src),
      `${rel} 缺少「标记块优先返回」分支`,
    )
    assert.ok(
      /if \(hasAnyMarked\)\s*return null;?/.test(src),
      `${rel} 缺少「本回复已有标记块则不兜底片段」判据 → 说明性片段会被当脚本推（回归）`,
    )
    assert.ok(
      src.includes('return firstUnseen'),
      `${rel} 缺少「整条回复无标记块时保留兜底」分支（AI 漏写头的自纠回路）`,
    )
    assert.ok(
      /if \(!firstUnseen\)\s*firstUnseen = item;?/.test(src),
      `${rel} 缺少 firstUnseen 记录（结构改动被回退？）`,
    )
  }
})

test('multi-script: headless 侧仍保留「连续 2 帧同 hash」的流式稳定判据', () => {
  const src = read(BROWSER_SRC)
  // 逐块放行后，稳定性判据成为「不把流式中途的残缺块推出去」的唯一屏障，必须还在
  assert.ok(src.includes('dedup._pendingScriptHash'), '稳定判据 _pendingScriptHash 被删 → 流式半截脚本会被直接推送')
  assert.ok(src.includes('if (script && !dedup.seenHashes.includes(script.hash))'), '调用处守卫应保持原样（稳定判据建立在它之上）')
})

test('multi-script: 油猴通道推送后必须主动再跑一次分类', () => {
  const src = read(TAMPERMONKEY_SRC)
  assert.ok(src.includes('function hasMoreUnseenBlocks'), '缺少 hasMoreUnseenBlocks（否则第 2、3 块永远不会被推送）')
  assert.ok(
    /if \(hasMoreUnseenBlocks\(\)\)\s*setTimeout\(classifyAndPost, 80\);?/.test(src),
    '推完一块后未唤醒分类 → DOM 已静止，observer 不再触发，后续块永久滞留',
  )
  // [stopped-no-autorun-v1] 停止轮同样不得再推脚本（残余块会落到「循环外自动执行」旁路）：
  //   判据与「标记让位」共用同一处三元表达式，两条语义必须**同时**在位
  assert.ok(
    /const s = \(markedNonScript \|\| stopPosted\) \? null : \(extractLatestScript/.test(src)
    || /if \(!markedNonScript && !stopPosted\) \{/.test(src),
    '脚本分类仍须让位于首行标记，且停止轮须停推脚本',
  )
  // [fragment-guard-text-v1] WO-20261007-06 段〇：TEXT 标记的回复，其代码块不得进 script 分支。
  // 只断言「存在 markedNonScript」不够——若 marks.text 从该表达式里漏掉，TEXT 回复的代码块仍会被推。
  assert.ok(
    /const markedNonScript = [^\n]*marks\.text\s*>\s*0/.test(src),
    'markedNonScript 未含 marks.text ⇒ TEXT 回复里的代码引用会被当脚本推（WO-06 段〇 P0 回归）',
  )
})

// [idle-wake-poll-v1] 油猴通道必须有「不依赖 DOM 变动」的唤醒兜底。
// [WHY] observer 只在 DOM 变动时触发；回复渲染完成后（流式光标移除 / 高亮完成 / 操作条挂载）
//   DOM 静止 ⇒ 若脚本块因任何原因尚未推送（闭合门延迟 / 生成中门 / 多块续推），
//   observer 永不触发，块永久滞留。2026-10-11 用户实测：滚动一下页面即收到（滚动引发的 DOM 变动唤醒）。
//   headless 侧 startReplyPoll 是 800ms 轮询天然无此症。
// [CONSTRAINT] 变异：删掉 setInterval 那一段 / 去掉 document.hidden 检查 / 去掉 latestAssistantRoot
//   前置 / 去掉 observerDebounce 抢跑门 ⇒ 本用例必红（分别对应：兜底丢失 / 后台空转 / 无容器误跑 / 与防抖抢）。
test('idle-wake-poll: 油猴通道必须有 DOM 静止后的轮询兜底（observer 之外的唤醒源）', () => {
  const src = read(TAMPERMONKEY_SRC)
  assert.ok(src.includes('[idle-wake-poll-v1]'), '缺少轮询兜底（DOM 静止后脚本块会永久滞留，只能靠用户滚动唤醒）')
  assert.ok(/setInterval\(\(\) => \{[\s\S]{0,600}classifyAndPost\(\)/.test(src), 'setInterval 内必须调用 classifyAndPost')
  assert.ok(src.includes('document.hidden'), '缺 document.hidden 检查 ⇒ 后台标签页会持续空转')
  assert.ok(/if \(!latestAssistantRoot\(\)\)\s*return;?/.test(src), '缺容器前置检查 ⇒ 无 assistant 容器时误跑')
  assert.ok(/if \(observerDebounce\)\s*return;?/.test(src), '缺 observerDebounce 抢跑门 ⇒ 与 350ms 防抖互相干扰')
  assert.ok(/\}, 800\)/.test(src), '轮询间隔须为 800（对齐 headless startReplyPoll）')
})
