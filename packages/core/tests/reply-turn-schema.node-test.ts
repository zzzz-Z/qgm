// [turn-schema-v1] 契约解析器的语义守卫。
//
// 覆盖三类风险：
//   ① 字段校验（缺 desc/why、lang 不在白名单、未知 type）必须**精确报错**，而不是静默丢弃；
//   ② 流式（尾部未闭合）必须能增量出块，且不得把半截当完整；
//   ③ 截体必须靠**配平扫描**，不能靠 ``` 正则 —— script.code 里出现反引号围栏时正则会在错处闭合。
//
// [CONSTRAINT] 「schema 不含 lane」单独一条断言：首版不支持的能力不得出现在契约里，
//   否则模型写了 lane 会被静默忽略 —— 那正是本方案要消灭的缺陷类型。
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { parseTurnPartial as parseTurnPartialRaw, parseTurn as parseTurnRaw, TURN_BLOCK_TYPES } from '../src/reply/turn-schema.js'

// [ts-view-v1] 源文件必须保持**零 TS 语法**（它被逐字复制进油猴 IIFE 片段与无头内联段，
//   TS 注解会原样进产物），代价是 `const out = { errors: [] }` 被推断成 `never[]`，
//   于是测试里 `r.errors[0].code` 全是 TS2339。这里补一份**最小的只读类型视图**，只影响本测试：
//   不引入第二套实现，也不让源文件为了测试而长出会泄漏进产物的类型标注。
interface TurnBlock {
  type: string
  id: string
  text?: string
  summary?: string
  question?: string
  options?: { id: string, label: string }[]
  lang?: string
  desc?: string
  why?: string
  code?: string
}
interface TurnError {
  code: string
  detail?: string
  block?: string
  field?: string
}
interface TurnResult {
  turn: number | null
  blocks: TurnBlock[]
  truncated: boolean
  errors: TurnError[]
}
type TurnPartial = Omit<TurnResult, 'truncated'>

const parseTurn = parseTurnRaw as unknown as (md: string) => TurnResult
const parseTurnPartial = parseTurnPartialRaw as unknown as (md: string) => TurnPartial

const SRC = fs.readFileSync(path.join(process.cwd(), 'packages/core/src/reply/turn-schema.ts'), 'utf8')

/** 便捷构造：把对象包成一条 ```json 围栏回复 */
function fence(obj: unknown): string {
  return `\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\``
}

const SAY = { type: 'say', text: '先探两路。' }
const C1 = { type: 'script', id: 'c1', lang: 'js', desc: '统计 md 分布', why: '决定先改哪几个', code: 'console.log(1)' }
const C2 = { type: 'script', id: 'c2', lang: 'cjs', desc: '确认工作区干净', why: '避免覆盖未提交', code: 'module.exports = 1' }
const ASK = { type: 'ask', id: 'q1', question: '要清理临时文件吗？', options: [{ id: 'a', label: '清理' }, { id: 'b', label: '跳过' }] }

describe('turn-schema: 正常形态', () => {
  it('四块齐全时按数组顺序返回，无错误', () => {
    const r = parseTurn(fence({ v: 1, turn: 7, content: [SAY, C1, C2, ASK] }))
    expect(r.errors).toEqual([])
    expect(r.turn).toBe(7)
    expect(r.blocks.map(b => b.type)).toEqual(['say', 'script', 'script', 'ask'])
    expect(r.blocks.map(b => b.id)).toEqual(['say_1', 'c1', 'c2', 'q1'])
  })

  it('只有 say 也成立（没有执行块 ⇒ 调用方判为本 turn 即总结）', () => {
    const r = parseTurn(fence({ v: 1, turn: 1, content: [SAY] }))
    expect(r.errors).toEqual([])
    expect(r.blocks.length).toBe(1)
    expect(r.blocks[0].type).toBe('say')
  })

  it('裸 JSON（无围栏）也接受', () => {
    const r = parseTurn(JSON.stringify({ v: 1, turn: 2, content: [SAY] }))
    expect(r.blocks.length).toBe(1)
  })

  it('ask 的 options 缺 id 时按顺序补 opt_N', () => {
    const r = parseTurn(fence({ v: 1, turn: 1, content: [{ type: 'ask', id: 'q', question: '选？', options: [{ label: '甲' }, { label: '乙' }] }] }))
    expect(r.blocks[0].options).toEqual([{ id: 'opt_1', label: '甲' }, { id: 'opt_2', label: '乙' }])
  })
})

describe('turn-schema: 校验必须精确报错', () => {
  it('content 为空数组 → TURN_NO_CONTENT', () => {
    const r = parseTurn(fence({ v: 1, turn: 1, content: [] }))
    expect(r.blocks).toEqual([])
    expect(r.errors.map(e => e.code)).toContain('TURN_NO_CONTENT')
  })

  it('不是 JSON → TURN_NOT_JSON', () => {
    const r = parseTurn('DONE\n\n## 总结\n普通文本')
    expect(r.blocks).toEqual([])
    expect(r.errors[0].code).toBe('TURN_NOT_JSON')
  })

  it('未知 type → BLOCK_UNKNOWN_TYPE，且该块被丢弃', () => {
    const r = parseTurn(fence({ v: 1, turn: 1, content: [{ type: 'read_file', id: 'r1', path: '/x' }, SAY] }))
    expect(r.errors.map(e => e.code)).toContain('BLOCK_UNKNOWN_TYPE')
    expect(r.blocks.map(b => b.type)).toEqual(['say'])
  })

  it('script 缺 desc/why 必须逐字段报错（历史 MISSING_DESC 469 次的根因）', () => {
    const r = parseTurn(fence({ v: 1, turn: 1, content: [{ type: 'script', id: 'c1', lang: 'js', code: 'x()' }] }))
    const fields = r.errors.filter(e => e.code === 'BLOCK_MISSING_FIELD').map(e => e.field)
    expect(fields).toContain('desc')
    expect(fields).toContain('why')
  })

  it('lang 不在白名单 → BLOCK_BAD_LANG（不做别名归一）', () => {
    const r = parseTurn(fence({ v: 1, turn: 1, content: [{ type: 'script', id: 'c1', lang: 'bash', desc: 'd', why: 'w', code: 'echo 1' }] }))
    expect(r.errors.map(e => e.code)).toContain('BLOCK_BAD_LANG')
  })
})

describe('turn-schema: 同 id 复用（改主意）', () => {
  it('同 id 同内容 → 只保留一份，不报冲突', () => {
    const r = parseTurn(fence({ v: 1, turn: 1, content: [C1, C1] }))
    expect(r.blocks.length).toBe(1)
    expect(r.errors.map(e => e.code)).not.toContain('BLOCK_DUP_ID')
  })

  it('同 id 不同内容 → 后到覆盖，并记 BLOCK_DUP_ID(superseded)', () => {
    const changed = { ...C1, code: 'console.log(2)' }
    const r = parseTurn(fence({ v: 1, turn: 1, content: [C1, changed] }))
    expect(r.blocks.length).toBe(1)
    expect(r.blocks[0].code).toBe('console.log(2)')
    const dup = r.errors.find(e => e.code === 'BLOCK_DUP_ID')
    expect(dup?.detail).toBe('superseded')
  })
})

describe('turn-schema: 截体必须靠配平，不能靠围栏正则', () => {
  it('script.code 内含反引号围栏仍能完整解析', () => {
    const tricky = { ...C1, code: 'const md = "```js\\nx\\n```"\nconsole.log(md)' }
    const r = parseTurn(fence({ v: 1, turn: 1, content: [tricky] }))
    expect(r.errors).toEqual([])
    expect(r.blocks[0].code).toBe(tricky.code)
  })

  it('code 内含未配对花括号的字符串也不会提前闭合', () => {
    const tricky = { ...C1, code: 'const s = "} not the end"; const o = { a: 1 }' }
    const r = parseTurn(fence({ v: 1, turn: 1, content: [tricky] }))
    expect(r.blocks[0]?.code).toBe(tricky.code)
  })

  it('尾部未闭合 → truncated=true，整段不产出块', () => {
    const full = fence({ v: 1, turn: 1, content: [SAY, C1] })
    const cut = full.slice(0, full.length - 40)
    const r = parseTurn(cut)
    expect(r.truncated).toBe(true)
    expect(r.blocks).toEqual([])
  })

  it('增量解析在未闭合时也能给出已配平的块', () => {
    const full = fence({ v: 1, turn: 3, content: [SAY, C1, C2] })
    const cut = full.slice(0, full.length - 30)
    const r = parseTurnPartial(cut)
    expect(r.turn).toBe(3)
    expect(r.blocks.map(b => b.id)).toEqual(['say_1', 'c1'])
  })
})

describe('turn-schema: 大载荷', () => {
  it('11KB 脚本原样往返（P0 已验证 DOM 保真，这里验证解析不截断）', () => {
    const code = Array.from({ length: 200 }, (_, i) => `const p${i} = "\\\\server\\\\share\\\\目录${i}"`).join('\n')
    const r = parseTurn(fence({ v: 1, turn: 1, content: [{ ...C1, code }] }))
    expect(r.blocks[0].code).toBe(code)
    expect(r.blocks[0].code?.length).toBe(code.length)
  })
})

describe('turn-schema: 契约边界', () => {
  it('首版只注册四类块', () => {
    expect(TURN_BLOCK_TYPES).toEqual(['say', 'script', 'ask', 'handoff'])
  })

  it('schema 源文件不得出现 lane（不支持的能力不得声明）', () => {
    expect(/['"]lane['"]/.test(SRC)).toBe(false)
  })

  it('源文件保持纯 JS：无 import、无 Date/Math.random', () => {
    // [guard-on-code-not-comments] 先剥注释再断言：文件头用「不用 Date / Math.random」
    //   说明这条约束，若直接扫原文会被自己的说明文字打成假红。
    const CODE = SRC
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    expect(/^\s*import\s/m.test(CODE)).toBe(false)
    expect(/Math\.random|new Date\(/.test(CODE)).toBe(false)
  })
})

// [raw-control-char-v1] 2026-10-19 用户实测：模型在 script.code 里敲**真换行**（U+000A）
//   而不是两字符的 `\n` 转义 ⇒ JSON.parse 抛 Bad control character ⇒ 整条信封解析不出对象
//   ⇒ 油猴回落 plain 把 JSON 原文整坨推上屏、script 零执行。
//   对照组（能跑的那份）只有 say 块、或 code 是合法转义 —— 差异**不在块结构，只在换行形态**。
//   本组断言把「裸控制字符必须仍能解析出块」钉死，并保证修复不误伤结构校验与幂等性。
describe('turn-schema: 字符串内裸控制字符（模型常见坏输出）', () => {
  // 真换行版信封：与用户实测载荷同构（code 内含真实 U+000A + 合法 \\n 转义两种换行）
  const RAW_NEWLINE_ENVELOPE = [
    '{',
    '"v": 1,',
    '"turn": 6,',
    '"content": [',
    '{',
    '"type": "say",',
    '"id": "s1",',
    '"text": "先读 AGENTS.md 确认锚点。"',
    '},',
    '{',
    '"type": "script",',
    '"id": "c1",',
    '"lang": "js",',
    '"desc": "读锚点",',
    '"why": "确认插入位置",',
    // code 里用真换行分行（非 \n 转义）—— 这正是让 JSON.parse 失败的形态
    '"code": "const a = 1;\nconst b = a + 1;\nconsole.log(b)"',
    '}',
    ']',
    '}',
  ].join('\n')

  it('真换行的 code仍解析出 script 块（修复前 blocks=0 / TURN_NOT_JSON）', () => {
    const r = parseTurn(RAW_NEWLINE_ENVELOPE)
    expect(r.errors).toEqual([])
    expect(r.blocks.map(b => b.type)).toEqual(['say', 'script'])
    expect(r.turn).toBe(6)
  })

  it('code 回读是真换行的可执行 JS（转义与缩进都还原）', () => {
    const r = parseTurn(RAW_NEWLINE_ENVELOPE)
    const script = r.blocks.find(b => b.type === 'script')
    expect(script?.code).toBe('const a = 1;\nconst b = a + 1;\nconsole.log(b)')
    expect(script?.code?.split('\n').length).toBe(3)
  })

  it('混合形态（部分 \n 转义 + 部分真换行）也能解析', () => {
    const mixed = '{"v":1,"turn":9,"content":[{"type":"script","id":"c1","lang":"js","desc":"d","why":"w","code":"a();\\nb();\nc()"}]}'
    const r = parseTurn(mixed)
    expect(r.errors).toEqual([])
    expect(r.blocks[0].code).toBe('a();\nb();\nc()')
  })

  it('严格 JSON 走原路径、结果不变（宽容只兜底，不改严格行为）', () => {
    const strict = fence({ v: 1, turn: 4, content: [SAY, C1] })
    const r = parseTurn(strict)
    expect(r.errors).toEqual([])
    expect(r.blocks.map(b => b.id)).toEqual(['say_1', 'c1'])
    expect(r.blocks[1].code).toBe('console.log(1)')
  })

  it('结构错误仍精确报错（宽容不得放宽块校验）', () => {
    // code 里塞裸换行，但 lang 非法 ⇒ 仍必须报 BLOCK_BAD_LANG，不能因转义被放过
    const bad = '{"v":1,"turn":1,"content":[{"type":"script","id":"c1","lang":"python","desc":"d","why":"w","code":"x = 1\ny = 2"}]}'
    const r = parseTurn(bad)
    expect(r.errors.some(e => e.code === 'BLOCK_BAD_LANG')).toBe(true)
  })

  it('增量解析对裸换行 code 同样出块（流式路径不能只修一半）', () => {
    const r = parseTurnPartial(RAW_NEWLINE_ENVELOPE)
    expect(r.blocks.map(b => b.type)).toEqual(['say', 'script'])
    expect(r.blocks[1].code).toBe('const a = 1;\nconst b = a + 1;\nconsole.log(b)')
  })
})
