// [commit-subject-v1] DONE 播报 → conventional commit 标题的解析守卫。
//
// 为什么需要守卫：`post-done-gate v1` 每次 DONE 都会落一个 checkpoint commit，而 DONE 播报是
// AI 的**对话体自由文本**（实测最长标题 335 字符）。把「约定一行 COMMIT:」变成标题的前提是
// 解析器真的按约定工作 —— 一旦它退化成「照抄摘要」，症状是 git log 慢慢变回不可追溯，
// 且不会有任何一处报错（与 turn-schema 漂移属同一族：静默失效）。
//
// 承重设计（改恒真必须变红）：
//   · 把 VALID_TYPES 清空 ⇒ T1/T2 立刻红（合法 type 被降级）；
//   · 把 RE_COMMIT 放宽成恒真 ⇒ T3/T4 红（非法 type 不再被拒）；
//   · 删掉截断 ⇒ T6 红；
//   · 若实现退化成「永远返回 fallback」⇒ T1/T2/T5 全红。
//
// [CONSTRAINT] 与生成器（bin/post-done.cjs）共用 scripts/lib/commit-subject.cjs 的同一套算法，
//   不各写一份 —— 与 reply-turn-fingerprint 同一教训。
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { test } from 'vitest'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const lib = require(path.join(process.cwd(), 'scripts/lib/commit-subject.cjs')) as {
  parseCommitSubject: (s: string) => { subject: string, source: string, type?: string, scope?: string }
  VALID_TYPES: string[]
  MAX_SUBJECT: number
}

const { parseCommitSubject, VALID_TYPES, MAX_SUBJECT } = lib

// 客户端（useAiReplyHandlers）用 ' / ' 拼 DONE 播报前 5 行 —— 守卫必须按**真实形态**喂入
const withCommit = (line: string, tail = '其余摘要'): string => `${line} / ${tail}`

test('T1 命中 COMMIT: 行 → 产出 conventional commit（含 scope）', () => {
  const r = parseCommitSubject(withCommit('COMMIT: fix(headless): 修正触顶正则自指'))
  assert.equal(r.source, 'commit-line')
  assert.equal(r.subject, 'fix(headless): 修正触顶正则自指')
  assert.equal(r.type, 'fix')
  assert.equal(r.scope, 'headless')
})

test('T2 无 scope 的合规形态同样接受', () => {
  const r = parseCommitSubject(withCommit('COMMIT: chore: 清理孤儿产物'))
  assert.equal(r.source, 'commit-line')
  assert.equal(r.subject, 'chore: 清理孤儿产物')
  assert.equal(r.scope, '')
})

test('T3 无 COMMIT: 行 → 明确降级为 chore(done): 摘要首段', () => {
  const r = parseCommitSubject('本轮把四件事全部落地 / 核心是根因修复')
  assert.equal(r.source, 'fallback')
  assert.equal(r.subject, 'chore(done): 本轮把四件事全部落地')
})

test('T4 type 非法 / 缺冒号 / 空内容 ⇒ 一律降级，绝不冒充 conventional commit', () => {
  for (const bad of [
    'COMMIT: unknown(scope): 瞎写的 type',
    'COMMIT: fix(scope) 少了冒号',
    'COMMIT:',
    'COMMIT:   ',
  ]) {
    assert.equal(parseCommitSubject(withCommit(bad)).source, 'fallback', `应降级却放行了：${bad}`)
  }
})

test('T5 全部合法 type 都被接受（白名单与 §12 契约逐字一致）', () => {
  assert.deepEqual(VALID_TYPES, ['feat', 'fix', 'chore', 'refactor', 'docs', 'test', 'perf'])
  for (const t of VALID_TYPES) {
    const r = parseCommitSubject(withCommit(`COMMIT: ${t}(s): 描述`))
    assert.equal(r.source, 'commit-line', `type ${t} 应被接受`)
    assert.equal(r.type, t)
  }
})

test('T6 超长标题按 MAX_SUBJECT 截断（git log --oneline 才有判别力）', () => {
  const long = '修'.repeat(200)
  const r = parseCommitSubject(withCommit(`COMMIT: fix(core): ${long}`))
  assert.equal(r.source, 'commit-line')
  assert.equal(r.subject.length, MAX_SUBJECT)
  assert.ok(r.subject.startsWith('fix(core): '), `前缀被截断了：${r.subject}`)
})

test('T7 subject 单行：不得含换行（git commit -m 多行会让 subject 变成首行、其余进 body 且易被截断）', () => {
  const r = parseCommitSubject(withCommit('COMMIT: feat(x): 单行标题'))
  assert.equal(r.subject.includes('\n'), false)
  assert.equal(r.subject.includes('\r'), false)
})

test('T8 空摘要 ⇒ 降级且不产出裸的空标题', () => {
  for (const empty of ['', '   ', ' / ']) {
    const r = parseCommitSubject(empty)
    assert.equal(r.source, 'fallback')
    assert.ok(r.subject.startsWith('chore(done):'), `降级标题前缀不对：${r.subject}`)
  }
})

test('T9 降级路径跳过 markdown 标题片段（"## 结论" 对 git log 无信息量）', () => {
  const r = parseCommitSubject('## 结论 / 真正的摘要在第一段之后')
  assert.equal(r.subject, 'chore(done): 真正的摘要在第一段之后')
})
