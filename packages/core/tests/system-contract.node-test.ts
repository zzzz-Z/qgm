// @desc SYSTEM.md 段间契约一致性守卫：ASK 两类定义同源 + §12 不得把 ASK 当不可修错误的出口
// @why P4：SYSTEM.md 每会话注入一次（load-rules.ts Promise 缓存 + useAiWindow sid 去重）却无守卫能查段间自相矛盾。2026-10-07 实证两处：① §12「修不动就 ASK」
//      与 §8「不上报 ASK」相左；② §1 状态 B 把「缺凭据」列为「不构成 ASK 理由」而状态 D 把它归入
//      合法的「沙箱物理不可为」类。两处均已修，本文件守住不回退（判据承重：回退任一处必红）。
//      读的是源码 SSOT（非运行态），与 module-size-ratchet.node-test.ts 同法。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const md = fs.readFileSync(path.join(process.cwd(), 'packages/core/SYSTEM.md'), 'utf8')

/** 截取 [start, end) 之间的正文；缺任一锚点即断言失败（防标题被改名后守卫静默通过） */
function slice(start: string, end: string): string {
  const a = md.indexOf(start)
  assert.ok(a > -1, `SYSTEM.md 找不到起始锚「${start}」`)
  const b = md.indexOf(end, a + start.length)
  assert.ok(b > a, `SYSTEM.md 找不到结束锚「${end}」`)
  return md.slice(a, b)
}

const stateB = slice('### 状态 B：ASK（交互阻断）', '### 状态 C：')
const stateD = slice('### 状态 D：DONE（任务终止）', '### 状态 E：')
const s8 = slice('## §8 错误恢复与重试预算', '## §9 ')
const s12 = slice('## §12 提交前自复检协议', '## §13 ')

test('G1 两类 ASK 定义跨段同源（§1 状态 B ↔ 状态 D）', () => {
  // 变异：从任一状态段删掉「沙箱物理不可为」⇒ 红
  for (const [name, seg] of [['状态 B', stateB], ['状态 D', stateD]] as const) {
    assert.ok(seg.includes('人类权威'), `${name} 缺「人类权威」类`)
    assert.ok(seg.includes('沙箱物理不可为'), `${name} 缺「沙箱物理不可为」类`)
  }
})

test('G2 §12 硬性规则不再把 ASK 当不可修错误的出口（改指 §8）', () => {
  // 变异：把 §12 第 2 条改回「修不动就 `ASK`」⇒ 两句断言均红
  assert.ok(!md.includes('修不动就 `ASK`'), '§12 旧矛盾句「修不动就 ASK」复活')
  assert.ok(s12.includes('metaerror-fuse-v1'), '§12 未指向 §8 熔断契约')
  assert.ok(s12.includes('不得转 `ASK`'), '§12 未显式禁止转 ASK')
})

test('G3 §8 熔断冻结必须明写「不上报 ASK」', () => {
  // 变异：删掉该短语 ⇒ 红
  assert.ok(s8.includes('不上报 `ASK`'), '§8 熔断未声明不上报 ASK')
})

test('G4 §1 状态 B 不再把「缺凭据」与「歧义/需用户决策」并列为不构成理由', () => {
  // 变异：回退该句 ⇒ 红（缺凭据是状态 D 认可的「沙箱物理不可为」，不得在 B 里被否定）
  assert.ok(!stateB.includes('「缺凭据」本身'), '状态 B 仍把缺凭据列为「本身不构成理由」，与状态 D 冲突')
})

test('G5 §1 状态 D 的 [DECIDE] 不再改写成 ASK（改指 fail 收尾 + 随 DONE 挂账）', () => {
  // 变异 1：把旧句「需人类决策（改用 ASK）」加回去 ⇒ 红
  // 变异 2：删掉「随 DONE 挂账」或「tasks.fail」任一 token ⇒ 红（只做删没做替）
  // [CONSTRAINT] 判据落在 stateD 段（状态 D → 状态 E）；三个 token 缺一即红
  assert.ok(!stateD.includes('改用 `ASK`'), '状态 D 又出现「改用 ASK」——与 §8 熔断处置（不上报 ASK）重新对立')
  assert.ok(stateD.includes('[DECIDE]'), '状态 D 段缺 [DECIDE] token')
  assert.ok(stateD.includes('tasks.fail'), '状态 D 段缺 tasks.fail（未写明做不成时先 fail 收尾）')
  assert.ok(stateD.includes('随 DONE 挂账'), '状态 D 段缺「随 DONE 挂账」（只删旧句未补新出口）')
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

test('G6-b 标注行里以行内代码写出的守卫路径必须在磁盘真实存在', () => {
  // 变异：把路径写成 `packages/core/tests/not-exist.node-test.ts` ⇒ 红
  // [CONSTRAINT] 只从标注行抽路径，不扫全文；只认 .node-test.ts / .cjs / .json
  const re = /`([a-zA-Z][\w./-]*\.(?:node-test\.ts|cjs|json))`/g
  const missing: string[] = []
  for (const c of chapters()) {
    const line = c.body.match(/^- 承重：.*$/m)
    if (!line) continue
    for (const p of line[0].matchAll(re)) {
      if (!fs.existsSync(path.join(process.cwd(), p[1]))) missing.push(`${c.num} → ${p[1]}`)
    }
  }
  assert.deepEqual(missing, [], `标注引用了不存在的守卫文件（改名后须同步）：\n${missing.join('\n')}`)
})
