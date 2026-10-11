// [task-board-shape-parity-v1] SYSTEM.md §2「返回形状」字段清单 ↔ tasks.cjs list() 真实返回字段的 parity 守卫。
// [WHY] §2 的字段清单是教学层（教 AI 怎么读 list()），tasks.cjs 的实现是门面；
//   两者漂移会教出错的读法——如漏列 failed ⇒ AI 误称「全部完成」（board-read-all-states-v1 的核心场景）。
//   本仓库已有先例：api-surface-parity 守 §3.2 的 API 名/arity；本守卫同法守 §2 的字段名。
// CHANGE-IMPACT: 删 tasks.cjs list() JSDoc @returns 任一字段或删 SYSTEM.md §2 任一字段 ⇒ 本测试红。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SM = path.join(ROOT, 'packages', 'core', 'SYSTEM.md')
const TASKS = path.join(ROOT, 'packages', 'core', 'src', 'helpers', 'tasks.cjs')

/** 从 SYSTEM.md §2「返回形状」行抽「读板」字段清单（第一个 `{...}`） */
function fieldsFromSystemMd(): string[] {
  const line = fs.readFileSync(SM, 'utf8').split('\n').find(l => l.includes('- **返回形状**：'))
  assert.ok(line, 'SYSTEM.md §2 找不到「返回形状」行')
  const m = line.match(/读板\s*`[^`]+`\s*→\s*`\{([^}]+)\}`/)
  assert.ok(m, 'SYSTEM.md §2 返回形状行的「读板」段格式变了，正则失配')
  return m[1].split(',').map(s => s.trim()).filter(Boolean)
}

/** 从 tasks.cjs 的 list() 函数 JSDoc @returns 抽字段名（去类型注解与 `?`） */
function fieldsFromTasksCjs(): string[] {
  const txt = fs.readFileSync(TASKS, 'utf8')
  const fnIdx = txt.indexOf('function list(')
  assert.ok(fnIdx > 0, 'tasks.cjs 找不到 function list(')
  const before = txt.slice(0, fnIdx)
  const last = before.lastIndexOf('@returns {Promise<{')
  assert.ok(last > 0, 'list() 上方找不到 @returns {Promise<{...}>} JSDoc')
  const rest = before.slice(last + '@returns {Promise<{'.length)
  const end = rest.indexOf('}>}')
  assert.ok(end > 0, 'list() 的 @returns 未闭合')
  const body = rest.slice(0, end)
  return body.split(',').map(s => s.trim().split(':')[0].replace(/\?$/, '')).filter(Boolean)
}

test('前置：两边字段清单都非空（防空转）', () => {
  assert.ok(fieldsFromSystemMd().length >= 5, 'SYSTEM.md §2 字段数异常')
  assert.ok(fieldsFromTasksCjs().length >= 5, 'tasks.cjs list() @returns 字段数异常')
})

test('SYSTEM.md §2 的 list() 字段在 tasks.cjs 中都存在', () => {
  const impl = new Set(fieldsFromTasksCjs())
  const missing = fieldsFromSystemMd().filter(f => !impl.has(f))
  assert.deepEqual(missing, [], `tasks.cjs list() @returns 缺字段：${missing.join(' ')}`)
})

test('tasks.cjs list() @returns 字段除 error 外都出现在 SYSTEM.md §2 读板字段中', () => {
  const md = new Set(fieldsFromSystemMd())
  const extra = fieldsFromTasksCjs().filter(f => f !== 'error' && !md.has(f))
  assert.deepEqual(extra, [], `SYSTEM.md §2 漏列 tasks.cjs 字段：${extra.join(' ')}`)
})
