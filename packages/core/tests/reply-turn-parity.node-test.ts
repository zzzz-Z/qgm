// [turn-parity-v1] 三处解析器的**行为**对拍：同一批样例，三端输出必须逐例完全相同。
//
// 为什么指纹不够：指纹只证明「代码体逐字相同」，证不了「三端跑起来的语义相同」——
//   一端被包在 IIFE 里（`this` / 全局作用域不同）、一端在 page.evaluate 的函数体内（闭包可见性不同），
//   逐字相同的源码也可能因宿主环境不同而分叉。本用例把三端都真跑一遍。
//
// 三端取法：
//   · 前端副本 → 真实 import（顺带验证生成物是合法模块）
//   · 油猴片段 → 抠代码体，vm 新上下文执行（片段无 export，可直接编译）
//   · 无头内联 → 同上，且**剥掉缩进**（段在函数体内，缩进 2 空格）
//
// [CONSTRAINT] 比较前一律 `JSON.parse(JSON.stringify(...))` 扁平化：
//   vm 里造出来的对象属于另一个 realm，其原型链与宿主不同，直接深比会因构造函数不同而误报。

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import vm from 'node:vm'
import { describe, expect, test } from 'vitest'
import * as CLIENT from '../../client/utils/turn-schema.js'
import { extractBody, sharedBody, SOURCE_REL, TARGETS } from '../../../scripts/lib/turn-schema-io.mjs'

const ROOT = process.cwd()

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

/** 在独立上下文里执行代码体，取回它导出的两个函数 */
function loadInVm(body: string): { parseTurn: (md: string) => unknown, parseTurnPartial: (md: string) => unknown } {
  const src = `${body}\n;({ parseTurn, parseTurnPartial })`
  return vm.runInNewContext(src, Object.create(null)) as { parseTurn: (md: string) => unknown, parseTurnPartial: (md: string) => unknown }
}

const TAMPER = 'packages/core/src/tampermonkey/turn-schema.ts'
const HEADLESS = 'packages/core/src/headless/headless-inject.ts'

/** 三端实现：名字 → { parseTurn, parseTurnPartial } */
const ENDS = [
  { name: 'client(import)', mod: CLIENT as unknown as { parseTurn: (md: string) => unknown, parseTurnPartial: (md: string) => unknown } },
  { name: 'tampermonkey(vm)', mod: loadInVm(extractBody(read(TAMPER)) ?? '') },
  { name: 'headless-inline(vm)', mod: loadInVm(extractBody(read(HEADLESS)) ?? '') },
]

/** 跨 realm 扁平化：只用 JSON 结构与标量，避免原型链差异 */
function flat(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v))
}

function fence(obj: unknown): string {
  return `\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\``
}

const SAY = { type: 'say', text: '先探两路。' }
const C1 = { type: 'script', id: 'c1', lang: 'js', desc: '统计 md 分布', why: '决定先改哪几个', code: 'console.log(1)' }
const C2 = { type: 'script', id: 'c2', lang: 'cjs', desc: '确认工作区干净', why: '避免覆盖未提交', code: 'module.exports = 1' }
const ASK = { type: 'ask', id: 'q1', question: '要清理临时文件吗？', options: [{ id: 'a', label: '清理' }, { id: 'b', label: '跳过' }] }
const HANDOFF = { type: 'handoff', id: 'h1', summary: '上下文要满了，换会话继续' }
const BIG_CODE = Array.from({ length: 200 }, (_, i) => `const p${i} = "\\\\\\\\server\\\\share\\\\目录${i}"`).join('\n')

/** 样例表：与 docs/plan/turn-envelope-v2-2026-10-19.md §P1 的样例表一一对应 */
const CASES: { name: string, md: string }[] = [
  { name: '正常四块', md: fence({ v: 1, turn: 7, content: [SAY, C1, C2, ASK] }) },
  { name: '只有 say', md: fence({ v: 1, turn: 1, content: [SAY] }) },
  { name: '只有 script', md: fence({ v: 1, turn: 2, content: [C1] }) },
  { name: 'handoff 块', md: fence({ v: 1, turn: 3, content: [HANDOFF] }) },
  { name: '块间无空行（紧凑 JSON）', md: `\`\`\`json\n${JSON.stringify({ v: 1, turn: 4, content: [SAY, C1, ASK] })}\n\`\`\`` },
  { name: 'content 为空数组', md: fence({ v: 1, turn: 5, content: [] }) },
  { name: '未知 type', md: fence({ v: 1, turn: 6, content: [{ type: 'lane', id: 'x' }] }) },
  { name: 'script 缺 desc', md: fence({ v: 1, turn: 7, content: [{ ...C1, desc: '' }] }) },
  { name: 'lang 不在白名单（bash）', md: fence({ v: 1, turn: 8, content: [{ ...C1, lang: 'bash' }] }) },
  { name: '同 id 不同内容（后到覆盖 + superseded）', md: fence({ v: 1, turn: 9, content: [C1, { ...C1, code: 'console.log(2)' }] }) },
  { name: '同 id 同内容（去重不报错）', md: fence({ v: 1, turn: 10, content: [C1, { ...C1 }] }) },
  { name: '裸 JSON 无围栏', md: JSON.stringify({ v: 1, turn: 11, content: [SAY] }) },
  { name: 'script.code 内含反引号围栏', md: fence({ v: 1, turn: 12, content: [{ ...C1, code: 'const s = "```js\\n1\\n```"' }] }) },
  { name: '尾部截断（半截块）', md: `${fence({ v: 1, turn: 13, content: [SAY, C1] }).slice(0, -40)}` },
  { name: '11KB 脚本', md: fence({ v: 1, turn: 14, content: [{ ...C1, code: BIG_CODE }] }) },
  { name: '完全不是信封', md: '普通回复，没有 JSON。' },
]

describe('turn 解析器三端行为对拍', () => {
  test('三个入口都真的拿到了函数（不比对「都是 undefined」这种假一致）', () => {
    for (const e of ENDS) {
      expect(typeof e.mod.parseTurn, `${e.name} 没有 parseTurn`).toBe('function')
      expect(typeof e.mod.parseTurnPartial, `${e.name} 没有 parseTurnPartial`).toBe('function')
    }
  })

  test(`parseTurn 逐例一致（${CASES.length} 例）`, () => {
    for (const c of CASES) {
      const results = ENDS.map(e => JSON.stringify(flat(e.mod.parseTurn(c.md))))
      expect(results[1], `[${c.name}] 油猴端与前端端输出不同\n前端: ${results[0]}\n油猴: ${results[1]}`).toBe(results[0])
      expect(results[2], `[${c.name}] 无头端与前端端输出不同\n前端: ${results[0]}\n无头: ${results[2]}`).toBe(results[0])
    }
  })

  test(`parseTurnPartial 逐例一致（${CASES.length} 例）`, () => {
    for (const c of CASES) {
      const results = ENDS.map(e => JSON.stringify(flat(e.mod.parseTurnPartial(c.md))))
      expect(results[1], `[${c.name}] 油猴端增量解析与前端端不同\n前端: ${results[0]}\n油猴: ${results[1]}`).toBe(results[0])
      expect(results[2], `[${c.name}] 无头端增量解析与前端端不同\n前端: ${results[0]}\n无头: ${results[2]}`).toBe(results[0])
    }
  })

  // [WHY] 「三端一起改错」是对拍的固有盲区：三方一致也可能三方都错。
  //   这里用**期望值**把关键语义钉死，改错时至少这一层会红。
  test('期望值锚定：对拍判不出「三端一起错」', () => {
    const four = flat(CLIENT.parseTurn(fence({ v: 1, turn: 7, content: [SAY, C1, C2, ASK] }))) as { turn: number, blocks: { id: string }[], errors: unknown[] }
    expect(four.turn).toBe(7)
    expect(four.blocks.map(b => b.id)).toEqual(['say_1', 'c1', 'c2', 'q1'])
    expect(four.errors).toEqual([])

    const dup = flat(CLIENT.parseTurn(fence({ v: 1, turn: 9, content: [C1, { ...C1, code: 'console.log(2)' }] }))) as { blocks: { code: string }[], errors: { code: string, detail?: string }[] }
    expect(dup.blocks.length, '同 id 不同内容应覆盖而不是新增').toBe(1)
    expect(dup.blocks[0].code).toBe('console.log(2)')
    expect(dup.errors.map(e => e.code)).toEqual(['BLOCK_DUP_ID'])

    const bad = flat(CLIENT.parseTurn(fence({ v: 1, turn: 8, content: [{ ...C1, lang: 'bash' }] }))) as { errors: { code: string }[] }
    expect(bad.errors.map(e => e.code)).toContain('BLOCK_BAD_LANG')

    const none = flat(CLIENT.parseTurn('普通回复，没有 JSON。')) as { blocks: unknown[], errors: { code: string }[] }
    expect(none.blocks).toEqual([])
    expect(none.errors.map(e => e.code)).toEqual(['TURN_NOT_JSON'])
  })

  // 反向：确保「三端都能被独立执行」这件事本身有判据 —— 若某端代码体在 vm 里抛出，
  // 上面的用例会以异常形式红，但错误信息会指向样例而非端，这里单独钉一次。
  test('每一端都能在各自宿主里独立求值且不依赖全局（无 window / document / process）', () => {
    for (const rel of [TAMPER, HEADLESS]) {
      const body = extractBody(read(rel)) ?? ''
      expect(body.length).toBeGreaterThan(0)
      for (const banned of ['window.', 'document.', 'process.', 'require(']) {
        expect(body.includes(banned), `${rel} 的代码体引用了 ${banned}，浏览器侧/IIFE 里必然 ReferenceError`).toBe(false)
      }
    }
  })

  // 代码体必须与源一致，否则本对拍比的是三份**各自不同**的副本（指纹守卫负责这条，
  // 这里再钉一次是因为「对拍全绿但都在比错东西」是本类守卫最隐蔽的失效）。
  test('对拍用的代码体确实来自唯一源', () => {
    const src = read(SOURCE_REL)
    for (const t of TARGETS) {
      expect(extractBody(read(t.rel))).toBe(sharedBody(src, t.mode))
    }
  })
})
