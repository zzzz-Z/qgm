// [worklog-v1] gitWorklog 特性单测（Characterization Test）
// [WHY] gitWorklog 是新增的 git diff → 工作日志能力，需固化其对外契约
// [CONSTRAINT] 依赖当前仓库为 git 仓库；非 git 环境部分断言自动跳过
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { gitWorklog } from '../../../packages/core/src/git.js'

test('gitWorklog: 默认 since=HEAD，返回完整结构', async () => {
  const r = await gitWorklog({ includeHistory: false })
  assert.equal(r.ok, true)
  assert.equal(r.since, 'HEAD')
  assert.equal(r.until, '')
  assert.ok(Array.isArray(r.files))
  assert.ok(Array.isArray(r.history))
  assert.equal(typeof r.markdown, 'string')
  assert.equal(typeof r.generatedAt, 'number')
})

test('gitWorklog: 合法 ref 原样保留', async () => {
  const r = await gitWorklog({ since: 'HEAD~2', includeHistory: false })
  assert.equal(r.since, 'HEAD~2')
})

test('gitWorklog: 非法 ref 被白名单过滤（无分号/空格）', async () => {
  const r = await gitWorklog({ since: 'HEAD; rm -rf /', includeHistory: false })
  assert.ok(!r.since.includes(';'), '分号应被过滤')
  assert.ok(!r.since.includes(' '), '空格应被过滤')
})

test('gitWorklog: until 也走白名单过滤', async () => {
  const r = await gitWorklog({ since: 'HEAD', until: 'HEAD~1$(whoami)', includeHistory: false })
  assert.ok(!r.until.includes('$'), '$ 应被过滤')
  assert.ok(!r.until.includes('('), '( 应被过滤')
})

test('gitWorklog: markdown 含标准标题与范围', async () => {
  const r = await gitWorklog({ includeHistory: false })
  assert.equal(r.ok, true)
  assert.ok(r.markdown.includes('# 工作日志'), '含一级标题')
  assert.ok(r.markdown.includes('## 变更概览'), '含变更概览')
  assert.ok(r.markdown.includes('**范围**'), '含范围行')
  assert.ok(r.markdown.includes('**文件数**'), '含文件数行')
})

test('gitWorklog: 空区间返回 ok 且 markdown 结构完整', async () => {
  // HEAD~1 到 HEAD~1：无差异，走空变更分支
  const r = await gitWorklog({ since: 'HEAD~1', until: 'HEAD~1', includeHistory: false })
  assert.equal(r.ok, true)
  assert.equal(r.files.length, 0)
  assert.ok(r.markdown.includes('（无变更）'), '空变更应显式标注')
})

test('gitWorklog: includeHistory=true 时 history 填充或为空数组', async () => {
  const r = await gitWorklog({ includeHistory: true })
  assert.equal(r.ok, true)
  assert.ok(Array.isArray(r.history))
})

test('gitWorklog: 非法区间（不存在的 ref）返回 ok:false 并带 reason', async () => {
  const r = await gitWorklog({ since: 'nonexistent-ref-xyz-9999', includeHistory: false })
  if (!r.ok) {
    // [TS18048] assert 不做类型收窄，先归一为字符串再断言
    const reason = r.reason ?? ''
    assert.equal(typeof reason, 'string')
    assert.ok(reason.length > 0, '失败应带 reason')
  }
})
