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
function buildPicker(rel: string, seen: string[], doc: unknown): () => Item | null {
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
    codeTextOf: (el: { textContent?: string }) => String((el && el.textContent) || '').replace(/^\n+|\n+$/g, ''),
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

// ============ 结构断言：不得退回「只取最后一块」 ============

test('multi-script: 两处实现都不得保留 lastMarked || last 的旧语义', () => {
  for (const rel of SOURCES) {
    const src = read(rel)
    assert.ok(
      !src.includes('return lastMarked || last'),
      `${rel} 仍是「取最后一块」→ 一条回复里的前序脚本会被静默丢弃（本次修复的核心回归点）`,
    )
    assert.ok(
      src.includes('return firstUnseenMarked || firstUnseen'),
      `${rel} 的取块语义应为「首个未见的标记块，兜底首个未见块」`,
    )
    assert.ok(
      src.includes('if (!firstUnseen) firstUnseen = item'),
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
    src.includes('if (hasMoreUnseenBlocks()) setTimeout(classifyAndPost, 80)'),
    '推完一块后未唤醒分类 → DOM 已静止，observer 不再触发，后续块永久滞留',
  )
  assert.ok(src.includes('const s = markedNonScript ? null : (extractLatestScript'), '脚本分类仍须让位于首行标记')
})
