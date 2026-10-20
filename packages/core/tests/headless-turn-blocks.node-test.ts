// [turn-envelope-v1] 无头侧「从页面读信封」这一步的守卫。
//
// 为什么单独测这一层：`detectReplyInPage` 整段是 page.evaluate 的序列化载荷，1159 行里
//   只有这一段与信封有关。把它当独立函数真跑（vm + 假 DOM），才能在不启动浏览器的情况下
//   给出「信封能被读出来、顺序不乱、半截不交付」的判据；否则只能靠 live 探针，一轮几十分钟。
//
// 三条判据（对应计划 P2 的验收）：
//   ① 一条信封含 2 个 script 块 ⇒ 两块都被采集且 id 正确（旧实现只取最后一块，是历史缺陷源）；
//   ② 顺序 == content 数组顺序（前端按数组顺序占位的前提，P6 依赖它）；
//   ③ 找不到信封 / 信封半截 ⇒ 返回 null（让旧标记链路原样接管，这是「零行为变化」的保证）。
//
// [CONSTRAINT] 与 multi-script-blocks 同一套 harness：抠函数体 + vm 注入依赖。
//   被抠的函数体内**不得有 TS 注解**（vm 直接编译会语法错），这条约束写在生产代码的注释里。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import vm from 'node:vm'
import { describe, expect, test } from 'vitest'
import { extractBody } from '../../../scripts/lib/turn-schema-io.mjs'

const BROWSER_SRC = 'packages/core/src/headless/headless-inject.ts'

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
    }
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return src.slice(braceAt + 1, i)
    }
  }
  throw new Error(`${name} 花括号不配平`)
}

interface ParsedTurn {
  turnId: number
  blocks: { type: string, id: string, code?: string, text?: string, lang?: string }[]
  errors: { code: string }[]
}

/** 用生产源码真跑一次 readTurnBlocks：解析器取内联段原文，读块函数取函数体 */
function buildReader(): (root: unknown) => ParsedTurn | null {
  const src = read(BROWSER_SRC)
  const turnParser = extractBody(src)
  assert.ok(turnParser, '无头内联段缺 BEGIN/END 标记')
  const inner = extractInner(src, 'readTurnBlocks')
  // [text-outside-fence-v1] readTurnBlocks 现在会调用同文件的 outsideFenceText 回收围栏外文本，
  //   vm 里必须把这个函数也一并抠进来，否则 ReferenceError: outsideFenceText is not defined。
  const outsideInner = extractInner(src, 'outsideFenceText')
  // [CONSTRAINT] vm.runInNewContext 按「脚本」编译，顶层 return 非法 ⇒ 必须包一层 IIFE
  const code = `(function () {
${turnParser}
function outsideFenceText(root) { ${outsideInner} }
function readTurnBlocks(root) { ${inner} }
return function (root) { return readTurnBlocks(root) }
})()`
  return vm.runInNewContext(code, Object.create(null)) as (root: unknown) => ParsedTurn | null
}

/** 假 DOM：一个 pre 节点（可带 code 子元素），与真实结构 pre > code 对齐 */
function makePre(preText: string, codeText?: string): unknown {
  const codeEl = codeText === undefined ? null : { textContent: codeText }
  return {
    textContent: preText,
    querySelector: (sel: string) => (sel === 'code' ? codeEl : null),
  }
}

/** 假 DOM：回复容器，querySelectorAll('pre') 返回若干代码块 */
function makeRoot(pres: unknown[]): unknown {
  return { querySelectorAll: (sel: string) => (sel === 'pre' ? pres : []) }
}

/** [no-fence-envelope-v1] 无 <pre>（回复未加 ```json 围栏）时，回退读取整条回复文本 */
function makeRootText(text: string): unknown {
  return { querySelectorAll: () => [], textContent: text }
}

/** [text-outside-fence-v1] 带 childNodes 的假 DOM：root 下既有围栏外文本节点、又有 PRE 信封，
 *   用于验证 outsideFenceText 能穿过 childNodes 把围栏外文本回收成 say 块。 */
function makeRootWithOutside(outsideText: string, preText: string): unknown {
  const pre = {
    tagName: 'PRE',
    childNodes: [] as unknown[],
    textContent: preText,
    querySelector: (sel: string) => (sel === 'code' ? { textContent: preText } : null),
  }
  return {
    nodeType: 1,
    tagName: 'DIV',
    childNodes: [
      { nodeType: 3, nodeValue: outsideText },
      { nodeType: 1, tagName: 'PRE', childNodes: [], querySelector: pre.querySelector, textContent: preText },
    ],
    querySelectorAll: (sel: string) => (sel === 'pre' ? [pre] : []),
  }
}

/** 信封原文（真实页面上就是 pre > code 的 textContent） */
function envelope(obj: unknown): string {
  return `\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\``
}

const SAY = { type: 'say', text: '先探两路。' }
const C1 = { type: 'script', id: 'c1', lang: 'js', desc: '统计 md 分布', why: '决定先改哪几个', code: 'console.log(1)' }
const C2 = { type: 'script', id: 'c2', lang: 'cjs', desc: '确认工作区干净', why: '避免覆盖未提交', code: 'module.exports = 1' }
const ASK = { type: 'ask', id: 'q1', question: '要清理临时文件吗？', options: [{ id: 'a', label: '清理' }, { id: 'b', label: '跳过' }] }

const reader = buildReader()

describe('readTurnBlocks：从页面读信封', () => {
  test('一条信封含 2 个 script 块 ⇒ 两块都采集到，id 正确（旧实现只取最后一块）', () => {
    const got = reader(makeRoot([makePre(envelope({ v: 1, turn: 3, content: [SAY, C1, C2] }))]))
    expect(got).not.toBeNull()
    expect(got!.turnId).toBe(3)
    expect(got!.blocks.map(b => b.id)).toEqual(['say_1', 'c1', 'c2'])
    expect(got!.blocks.filter(b => b.type === 'script').map(b => b.code)).toEqual(['console.log(1)', 'module.exports = 1'])
  })

  test('顺序 == content 数组顺序（前端按数组顺序占位的前提）', () => {
    const got = reader(makeRoot([makePre(envelope({ v: 1, turn: 1, content: [C2, SAY, C1] }))]))
    // [NOTE] say 没写 id 时按**数组下标**补 `say_{index+1}`（此例 SAY 在下标 1 ⇒ say_2）。
    //   这带来一个已知风险：流式过程中若在前面插入块，同一条 say 的自动 id 会漂移 ⇒
    //   按 `turn|id` 去重会把它当新块再推一次。规避靠「模型给显式 id」（P7 契约里写死），
    //   say 的自动 id 只在「整条信封一次性到达」时稳定。P5 的执行账本与此无关（只认 script/ask 的显式 id）。
    expect(got!.blocks.map(b => b.id)).toEqual(['c2', 'say_2', 'c1'])
  })

  test('ask 块的 options 原样带出（不再靠文本解析）', () => {
    const got = reader(makeRoot([makePre(envelope({ v: 1, turn: 2, content: [ASK] }))]))
    expect(got!.blocks[0].type).toBe('ask')
    expect((got!.blocks[0] as unknown as { options: unknown[] }).options).toEqual([{ id: 'a', label: '清理' }, { id: 'b', label: '跳过' }])
  })

  test('无信封 ⇒ null（旧标记链路原样接管，这是零行为变化的保证）', () => {
    expect(reader(makeRoot([makePre('SCRIPT\n```js\nconsole.log(1)\n```')]))).toBeNull()
    expect(reader(makeRoot([makePre('普通回复，没有任何 JSON。')]))).toBeNull()
    expect(reader(makeRoot([]))).toBeNull()
    expect(reader(null)).toBeNull()
  })

  test('半截信封（流式未闭合）⇒ null，等下一拍而不是交付半截', () => {
    const full = envelope({ v: 1, turn: 4, content: [SAY, C1] })
    const half = full.slice(0, -30)
    expect(reader(makeRoot([makePre(half)]))).toBeNull()
  })

  // [WHY] 上一条其实由 `blocks.length === 0` 兜住了（未闭合 ⇒ parseTurn 一个块都不出），
  //   `truncated` 闸门在那条路径上是冗余的 —— 实测删掉它测试依然全绿（变异存活）。
  //   它真正承重的场景是**同一段文本里既有闭合信封、又有未闭合信封**：
  //   此时 parseTurn 会拿闭合那个的 blocks，同时 truncated=true；没有闸门就会把「上一版」交付出去。
  test('同一段文本里闭合信封 + 未闭合信封 ⇒ null（truncated 闸门承重的那条路径）', () => {
    const closed = envelope({ v: 1, turn: 9, content: [C1] })
    const partial = '```json\n{ "v": 1, "turn": 10, "content": ['
    expect(reader(makeRoot([makePre(`${closed}\n\n${partial}`)]))).toBeNull()
  })

  test('content 为空数组 / 非信封 JSON ⇒ null（不能把普通 json 代码块当信封）', () => {
    expect(reader(makeRoot([makePre(envelope({ v: 1, turn: 5, content: [] }))]))).toBeNull()
    expect(reader(makeRoot([makePre('{ "a": 1, "b": [2, 3] }')]))).toBeNull()
  })

  test('pre 没有 code 子元素时用 pre.textContent 兜底（站点改版容错）', () => {
    const got = reader(makeRoot([makePre(envelope({ v: 1, turn: 6, content: [SAY] }))]))
    expect(got!.blocks.length).toBe(1)
  })

  test('多个代码块时取命中信封的那个（信封通常是最后一个，但不假定位置）', () => {
    const root = makeRoot([
      makePre('const x = 1'), // 回复里的普通示例块，不是信封
      makePre(envelope({ v: 1, turn: 7, content: [C1] })),
    ])
    expect(reader(root)!.blocks.map(b => b.id)).toEqual(['c1'])
  })

  test('缺 turn 字段时 turnId 归一为 0（不返回 undefined 污染下游 key）', () => {
    const got = reader(makeRoot([makePre(envelope({ v: 1, content: [SAY] }))]))
    expect(got!.turnId).toBe(0)
  })

  test('跨 realm 扁平化后字段可深比（守卫自身不踩原型链差异）', () => {
    const got = reader(makeRoot([makePre(envelope({ v: 1, turn: 8, content: [C1] }))]))
    const flat = JSON.parse(JSON.stringify(got))
    expect(flat.blocks[0]).toEqual({ type: 'script', id: 'c1', lang: 'js', desc: '统计 md 分布', why: '决定先改哪几个', code: 'console.log(1)' })
  })

  test('无 <pre> 围栏（裸 JSON）⇒ 回退解析整条回复文本 [no-fence-envelope-v1]', () => {
    const bare = JSON.stringify({ v: 1, turn: 11, content: [C1, SAY] })
    const got = reader(makeRootText(bare))
    expect(got).not.toBeNull()
    expect(got!.turnId).toBe(11)
    expect(got!.blocks.map(b => b.id)).toEqual(['c1', 'say_2'])
  })

  test('回退分支不误吞：普通文本 / 非信封 JSON / 未闭合 ⇒ null', () => {
    expect(reader(makeRootText('普通回复，没有任何 JSON。'))).toBeNull()
    expect(reader(makeRootText('{ "a": 1, "b": [2, 3] }'))).toBeNull()
    const half = JSON.stringify({ v: 1, turn: 12, content: [C1] }).slice(0, -6)
    expect(reader(makeRootText(half))).toBeNull()
  })

  test('<pre> 命中时优先于文本回退（既有围栏路径行为不变）', () => {
    const root = {
      querySelectorAll: (sel: string) => (sel === 'pre' ? [makePre(envelope({ v: 1, turn: 13, content: [C1] }))] : []),
      textContent: JSON.stringify({ v: 1, turn: 88, content: [C2] }),
    }
    expect(reader(root)!.turnId).toBe(13)
  })

  // [text-outside-fence-v1] 无头侧与油猴 readTurnFromRoot 同构：围栏外文本回收成 outside_<turnId> say 块。
  test('[text-outside-fence-v1] 信封合法但围栏外有文本 ⇒ 回收为 outside_<turnId> say 块 + TEXT_OUTSIDE_FENCE', () => {
    const got = reader(makeRootWithOutside('这是写在信封外面的说明', envelope({ v: 1, turn: 21, content: [C1] })))
    expect(got).not.toBeNull()
    expect(got!.turnId).toBe(21)
    expect(got!.blocks.map(b => b.id)).toEqual(['c1', 'outside_21'])
    expect(got!.blocks.find(b => b.id === 'outside_21')).toEqual({ type: 'say', id: 'outside_21', text: '这是写在信封外面的说明' })
    expect(got!.errors.some(e => e.code === 'TEXT_OUTSIDE_FENCE')).toBe(true)
  })

  test('[text-outside-fence-v1] 围栏外只有空白 ⇒ 不回收（trim 后为空）', () => {
    const got = reader(makeRootWithOutside('   \n\t  ', envelope({ v: 1, turn: 22, content: [SAY] })))
    expect(got!.blocks.map(b => b.id)).toEqual(['say_1'])
    expect(got!.errors.some(e => e.code === 'TEXT_OUTSIDE_FENCE')).toBe(false)
  })
})
