// [error-mode-parity-v1] 失败模式收敛守卫（H2）。
//
// [WHY] 18 个 helper 族里 throw / {ok:false} / exit() 三套失败模式并存，调用方没有一种
//   写法是普适正确的：写 if (!r.ok) 漏掉抛异常型，写 try/catch 漏掉 {ok:false} 型。
//
// [CONSTRAINT] 本守卫**冻结现状**而非立即改行为：现有 throw 站点进白名单，新增即红。
//   收敛方向是「沙箱 API 一律不抛、统一 {ok:false,error,code?}」，迁移时同步删白名单项。
//   白名单只减不增——这保证失败模式不会继续扩散。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const HELPERS = path.join(ROOT, 'packages/core/src/helpers')

// 现存 throw 站点基线（file:line）。迁移完成后应收缩至空。
const THROW_BASELINE = new Set([
  'io.cjs:116',
  'io.cjs:157',
  'io.cjs:161',
  'io.cjs:162',
  'patch.cjs:36',
  'patch.cjs:76',
  'patch.cjs:86',
  'patch.cjs:98',
  'search.cjs:200',
  'search.cjs:201',
  'state.cjs:50',
])

test('throw 站点不得新增（只减不增）', () => {
  const offenders: string[] = []
  const names = ['browser.cjs', 'fs.cjs', 'git.cjs', 'io.cjs', 'lessons.cjs', 'lint.cjs', 'misc.cjs', 'output.cjs', 'patch.cjs', 'probe.cjs', 'search.cjs', 'session.cjs', 'shell.cjs', 'skill.cjs', 'state.cjs', 'subagent.cjs', 'tasks.cjs', 'util.cjs']
  for (const name of names) {
    const text = readFileSync(path.join(HELPERS, name), 'utf8')
    text.split('\n').forEach((line, i) => {
      if (!/throw\s+new/.test(line) || /^\s*\*/.test(line)) return
      const key = `${name}:${i + 1}`
      if (!THROW_BASELINE.has(key)) offenders.push(key)
    })
  }
  expect(offenders, `新增 throw 站点（应改返回 {ok:false,error}）：\n${offenders.join('\n')}`).toEqual([])
})
