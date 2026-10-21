// @desc SYSTEM.md 段间契约一致性守卫：ASK 两类定义同源 + §12 不得把 ASK 当不可修错误的出口
// @why P4：SYSTEM.md 每会话注入一次（load-rules.ts Promise 缓存 + useAiWindow sid 去重）却无守卫能查段间自相矛盾。2026-10-07 实证两处：① §12「修不动就 ASK」
//      与 §8「不上报 ASK」相左；② §1 状态 B 把「缺凭据」列为「不构成 ASK 理由」而状态 D 把它归入
//      合法的「沙箱物理不可为」类。两处均已修，本文件守住不回退（判据承重：回退任一处必红）。
//      读的是源码 SSOT（非运行态），与 module-size-ratchet.node-test.ts 同法。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { parseTurn as parseTurnRaw } from '../src/reply/turn-schema.js'

const md = fs.readFileSync(path.join(process.cwd(), 'packages/core/SYSTEM.md'), 'utf8')

interface ParsedTurn {
  turn: number | null
  blocks: unknown[]
  truncated: boolean
  errors: unknown[]
}
const parseTurn = parseTurnRaw as unknown as (md: string) => ParsedTurn

/** 包成 ```json 围栏（解析器真实入口：它自己会找围栏） */
function fence(obj: unknown): string {
  return `\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\``
}

/** 截取 [start, end) 之间的正文；缺任一锚点即断言失败（防标题被改名后守卫静默通过） */
function slice(start: string, end: string): string {
  const a = md.indexOf(start)
  assert.ok(a > -1, `SYSTEM.md 找不到起始锚「${start}」`)
  const b = md.indexOf(end, a + start.length)
  assert.ok(b > a, `SYSTEM.md 找不到结束锚「${end}」`)
  return md.slice(a, b)
}

test('G3 §8 熔断冻结必须明写「不上报 ASK」', () => {
  // 变异：删掉该短语 ⇒ 红
  const s8 = slice('## §8 错误恢复与重试预算', '## §9 ')
  assert.ok(s8.includes('不上报 `ask` 块') || s8.includes('不上报 `ASK`'), '§8 熔断未声明不上报 ask 块')
})

// ── [system-md-bearing-v1] G6：每章「承重：」标注 + 标注路径存在性 ──
// [WHY] SYSTEM.md 反复出现「写了但没人执行」的落差（§0.1 自己的诚实传统 vs §10 预算无闸门，仅留痕）。
//   本判据把「这条规则有没有机器承重」变成可机检项，让读者一眼看出、让改名当场变红。
// [CONSTRAINT] 只解析 `- 承重：` 行（不扫全文），避免正文示例误报；只校验三种后缀。

/** 按 `## §N` 切分；每段体 = 标题行到下一章标题（或文末） */
function chapters(): Array<{ num: string, body: string }> {
  const re = /^## (§[\d.]+)\s.*$/gm
  const marks: Array<{ num: string, at: number }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(md)) !== null) marks.push({ num: m[1], at: m.index })
  assert.ok(marks.length > 10, `SYSTEM.md 只切出 ${marks.length} 章，扫描器可能失效`)
  return marks.map((x, i) => ({
    num: x.num,
    body: md.slice(x.at, i + 1 < marks.length ? marks[i + 1].at : md.length),
  }))
}

test('G6-a 每个 §N 章必须含「- 承重：」标注（承重覆盖可机检）', () => {
  // 变异：删掉任一章的标注行 ⇒ 红
  const missing = chapters().filter(c => !/^- 承重：/m.test(c.body)).map(c => c.num)
  assert.deepEqual(missing, [], `缺「- 承重：」标注的章：${missing.join(', ')}（每章须声明有无机器守卫）`)
})

test('G6-b 项目索引的「承重实现对照」表引用的守卫路径必须在磁盘真实存在', () => {
  // [WHY] SYSTEM.md 的「承重：」行只留契约名（应用级规则不得含工作区路径），路径统一登记在
  //   AGENTS.md 的「SYSTEM.md 各章承重实现对照」；本判据守住那张表，让「换守卫 / 改名」当场变红，
  //   而不是把守卫真空掉。
  // [CONSTRAINT] 只从该节抽路径（到下一个 `## ` 标题为止），避免全文误报；只认三种后缀。
  const agents = fs.readFileSync(path.join(process.cwd(), 'AGENTS.md'), 'utf8')
  const head = '## SYSTEM.md 各章承重实现对照'
  const a = agents.indexOf(head)
  assert.ok(a > -1, `AGENTS.md 找不到「${head}」节`)
  const rest = agents.slice(a)
  const b = rest.indexOf('\n## ')
  const block = b > -1 ? rest.slice(0, b) : rest
  const re = /`([a-zA-Z][\w./-]*\.(?:node-test\.ts|cjs|json))`/g
  const missing: string[] = []
  let count = 0
  for (const p of block.matchAll(re)) {
    count++
    if (!fs.existsSync(path.join(process.cwd(), p[1]))) missing.push(p[1])
  }
  assert.ok(count >= 5, `对照表只抽到 ${count} 个守卫路径，扫描器可能失效`)
  assert.deepEqual(missing, [], `对照表引用了不存在的守卫文件（改名后须同步）：\n${missing.join('\n')}`)
})

// ── [system-md-examples-v1] G10：契约文档的 JSON 示例 ⟺ 解析器行为 ──
// [WHY] 文档与解析器会各自漂移：文档改了骨架而解析器没跟上（或反之），
//   模型照文档写出来的信封在采集侧被整轮丢弃 —— 不报错，只表现为「AI 什么都没干」，
//   正是 §17 最难自查的那一类失效。这里把它钉成机器判据（双向）。
// [CONSTRAINT] 只认 ```json 围栏；非信封的 JSON 示例请改用 ```text / ```ts，否则 G10-a 会红。

/** 抽出 SYSTEM.md 里所有 ```json 围栏（含围栏行本身，走解析器真实入口） */
function jsonFences(): Array<{ line: number, raw: string }> {
  const out: Array<{ line: number, raw: string }> = []
  const re = /^[ \t]*```[ \t]*json[ \t]*\r?\n[\s\S]*?^[ \t]*```[ \t]*$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(md)) !== null) {
    out.push({ line: md.slice(0, m.index).split('\n').length, raw: m[0] })
  }
  return out
}

test('G10-a §1 的每个 json 骨架示例都能被 parseTurn 解析通过', () => {
  // 变异：删骨架里任一必填字段、或把 type 改成注册表名之外的名字 ⇒ 红
  const fences = jsonFences()
  assert.ok(fences.length >= 2, `只抽到 ${fences.length} 个 json 示例（骨架 A / B 应各一个）`)
  for (const f of fences) {
    const r = parseTurn(f.raw)
    assert.equal(r.errors.length, 0, `第 ${f.line} 行的 json 示例解析报错：${JSON.stringify(r.errors)}`)
    assert.ok(r.blocks.length > 0, `第 ${f.line} 行的 json 示例未产出任何块`)
    assert.equal(r.truncated, false, `第 ${f.line} 行的 json 示例被判为截断（花括号未配平？）`)
  }
})

test('G10-b §1.5 列的每个错误码都必须由解析器真实发出（防文档空头承诺）', () => {
  // [WHY] 单向守卫不够：文档写了一个解析器从不产生的 code，模型照着改也修不好，
  //   而这条承诺恰恰是「回灌自纠」的落点。历史教训：schema 只声明已实现的能力。
  const sec15 = slice('### §1.5 错误码（回灌自纠）', '### §1.6 ')
  const codes = [...sec15.matchAll(/`([A-Z][A-Z_]+)`/g)].map(m => m[1])
  assert.ok(codes.length >= 7, `只抽到 ${codes.length} 个错误码：${codes.join(',')}`)
  const emitted = new Set<string>()
  const probe = (text: string): void => {
    for (const e of parseTurn(text).errors) emitted.add(String((e as { code?: string }).code))
  }
  probe('') // TURN_NOT_JSON（空输入）
  probe('DONE\n\n## 总结\n裸文本') // TURN_NOT_JSON
  probe(fence({ v: 1, turn: 1, content: [] })) // TURN_NO_CONTENT
  probe(fence({ v: 1, turn: 1, content: [{ type: 'nope', id: 'x1' }] })) // BLOCK_UNKNOWN_TYPE
  probe(fence({ v: 1, turn: 1, content: [{ type: 'script', id: 'c1' }] })) // BLOCK_MISSING_FIELD
  // BLOCK_BAD_LANG
  probe(fence({ v: 1, turn: 1, content: [{ type: 'script', id: 'c1', lang: 'bash', desc: 'd', why: 'w', code: 'x' }] }))
  // BLOCK_DUP_ID
  probe(fence({ v: 1, turn: 1, content: [{ type: 'say', id: 's1', text: 'a' }, { type: 'say', id: 's1', text: 'b' }] }))
  probe('```json\n{ "v": 1, "turn": 1, "content": [') // TURN_TRUNCATED
  // BLOCK_INVALID_FIELD：done 块 commit 格式非法
  probe(fence({ v: 1, turn: 1, content: [{ type: 'done', id: 'd1', summary: 'x', commit: '不是 conventional' }] }))
  const missing = codes.filter(c => !emitted.has(c))
  assert.deepEqual(missing, [], `文档声明了但解析器从不发出的错误码：${missing.join(', ')}`)
})

test('G10-c §1.5 反向守卫：代码产出的每个错误码都必须在文档登记（防文档漏登）', () => {
  // [WHY] G10-b 只守「文档 → 代码」单向；反向漂移（代码加新码但文档不写）静默发生。
  //   实测：BLOCK_INVALID_FIELD 在 done 块改造时新增，文档漏登，G10-b 一直绿。
  const src = fs.readFileSync(path.join(process.cwd(), 'packages/core/src/reply/turn-schema.ts'), 'utf8')
  const found = new Set<string>()
  for (const m of src.matchAll(/code:\s*['"]([A-Z][A-Z_]+)['"]/g)) found.add(m[1])
  assert.ok(found.size >= 7, `只抽到 ${found.size} 个错误码：${[...found].join(',')}`)
  const sec15 = slice('### §1.5 错误码（回灌自纠）', '### §1.6 ')
  const documented = new Set([...sec15.matchAll(/`([A-Z][A-Z_]+)`/g)].map(m => m[1]))
  const undocumented = [...found].filter(c => !documented.has(c))
  assert.deepEqual(undocumented, [], `代码产出但文档未登记的错误码：${undocumented.join(', ')}（§1.5 需补行）`)
})
