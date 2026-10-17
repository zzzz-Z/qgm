// @desc SYSTEM.md 结构一致性守卫：附录A 完整性 + 详见章节存在 + 契约名形态归一 + 未登记侦测
// @why 2026-10-17 两次压缩附录 A 都因正则被表格里的 `\|` 截断，把 37 条压成 1 条且无任何守卫报警。
//   本文件把「附录不能少条目」变成 ratchet 判据，并顺带守住契约名的两种写法（连字符 / 空格）不再混用。
// [CONSTRAINT] 只解析表格与 §0.1 列表，不扫全文散文：散文里提契约名是正常的，不该要求登记。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const MD = path.join(process.cwd(), 'packages/core/SYSTEM.md')
const src = fs.readFileSync(MD, 'utf8')

/** 附录 A 区间（到附录 B 或文末） */
function appendixA(): string {
  const a = src.indexOf('## 附录 A')
  assert.ok(a > -1, '找不到附录 A 标题')
  const b = src.indexOf('## 附录 B')
  return src.slice(a, b > a ? b : src.length)
}

/** 附录 A 的数据行（排除表头与分隔行） */
function appendixRows(): string[] {
  return appendixA().split('\n').filter((l) => {
    const t = l.trim()
    return t.startsWith('|') && !/^\|\s*-+/.test(t) && !t.includes('契约名')
  })
}

/** 归一化：'x v1' 与 'x-v1' 视为同一契约名 */
function norm(name: string): string {
  return name.trim().replace(/ v(\d+)$/, '-v$1')
}

test('A1 附录 A 行数 ratchet：不得少于基线 37（防破坏性编辑把索引压没）', () => {
  // [WHY] 两次事故都是「正则写错 → 只剩 1 条 → 无人报警」。行数是唯一能在压缩时立刻红的判据。
  // [CONSTRAINT] 只增不减：新增契约名应加行，删条目须同步下调本数字并说明理由。
  const n = appendixRows().length
  assert.ok(n >= 37, `附录 A 只剩 ${n} 行（基线 37）。若是压缩导致，请先确认没有丢失条目`)
})

test('A2 附录 A 每条「详见」引用的章节必须存在', () => {
  const heads = new Set([...src.matchAll(/^#{2,3}\s+§([\d.]+)/gm)].map(m => m[1]))
  const bad: string[] = []
  for (const row of appendixRows()) {
    const cols = row.split('|').map(x => x.trim()).filter(Boolean)
    const detail = cols[cols.length - 1] || ''
    for (const m of detail.matchAll(/§([\d.]+)/g)) {
      if (!heads.has(m[1])) bad.push(`${cols[0]} → §${m[1]}`)
    }
  }
  assert.deepEqual(bad, [], `附录 A 引用了不存在的章节：\n${bad.join('\n')}`)
})

test('A3 契约名归一化后唯一：同一契约不得在附录里出现两种写法', () => {
  // [WHY] `verify-contract v1` 与 `verify-contract-v1` 会被 grep 当成两个东西，读者也会以为有两套。
  const seen = new Map<string, string[]>()
  for (const row of appendixRows()) {
    const first = row.split('|').map(x => x.trim()).filter(Boolean)[0] || ''
    const raw = first.replace(/`/g, '')
    if (!/v\d+$/.test(raw)) continue
    const key = norm(raw)
    seen.set(key, [...(seen.get(key) || []), raw])
  }
  const conflict = [...seen.entries()].filter(([, forms]) => new Set(forms).size > 1)
  assert.deepEqual(conflict, [], `附录 A 内同一契约名有两种写法：${JSON.stringify(conflict)}`)
})

test('A4 §0.1 宿主机制表的每个机制名都在附录 A 有对应条目', () => {
  // [WHY] §0.1 自述「本表登记宿主侧，附录 A 登记全局」——但宿主机制同时也是契约名，不登记就查不到。
  const s01 = src.slice(src.indexOf('## §0.1'), src.indexOf('## §1 '))
  assert.ok(s01.length > 200, '§0.1 区间切片异常')
  const mech = new Set<string>()
  for (const m of s01.matchAll(/`([a-z][a-z0-9-]+ v\d+)`/g)) mech.add(norm(m[1]))
  const registered = new Set(appendixRows().map(r => norm(r.split('|').map(x => x.trim()).filter(Boolean)[0].replace(/`/g, ''))))
  const missing = [...mech].filter(n => !registered.has(n))
  assert.deepEqual(missing, [], `§0.1 的机制未在附录 A 登记：\n${missing.join('\n')}`)
})
