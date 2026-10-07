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
