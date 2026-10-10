// [docs-retrieval-guard-v1] docs 检索守卫：白名单冻结 + 切块口径 + 排序承重 + scope 端点。
// [承重要求] 每条判据对应可变异点；改坏实现本条必红。
import { afterEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { isDocWhitelisted, listDocChunks, rankDocChunks } from '../src/retrieval/docs-retriever.js'
import { getRoot, setRoot } from '../src/config.js'

const ORIG_ROOT = getRoot()
afterEach(() => { setRoot(ORIG_ROOT) })

test('白名单: 收 docs/*.md 一级知识文档', () => {
  assert.ok(isDocWhitelisted('docs/DESIGN.md'))
  assert.ok(isDocWhitelisted('docs/FRONTEND-REVIEW.md'))
  assert.ok(isDocWhitelisted('docs/USAGE.md'))
})

test('白名单: 排除工单 / 日期后缀 / 子目录', () => {
  assert.equal(isDocWhitelisted('docs/workorder-app-foo-2026-10-07.md'), false)
  assert.equal(isDocWhitelisted('docs/plan/x.md'), false)
  assert.equal(isDocWhitelisted('docs/archive/x.md'), false)
  assert.equal(isDocWhitelisted('README.md'), false)
})

test('冻结清单: 真仓库入选集合精确等于预期', () => {
  const chunks = listDocChunks(ORIG_ROOT)
  const srcs = Array.from(new Set(chunks.map(c => c.src))).sort()
  const EXPECTED = [
    'docs/DESIGN.md',
    'docs/DOCS-INDEX.md',
    'docs/FRONTEND-REVIEW.md',
    'docs/USAGE.md',
    'docs/defect-review-verification.md',
    'docs/defect-review.md',
    'docs/plan-agent-loop-alignment.md',
    'docs/session-view-diagnosis.md',
  ].sort()
  assert.deepEqual(srcs, EXPECTED, '入选集合变了——新增/删除文档须同步此清单（ratchet）')
})

test('每块必带 {src, srcKind, hash}', () => {
  const chunks = listDocChunks(ORIG_ROOT)
  assert.ok(chunks.length > 0)
  for (const c of chunks) {
    assert.ok(c.src.startsWith('docs/'))
    assert.equal(c.srcKind, 'doc')
    assert.ok(/^[0-9a-f]+$/.test(c.hash))
  }
})

function mkChunk(title: string, body: string) {
  return { title, body, src: 'docs/a.md', srcKind: 'doc' as const, hash: 'h' }
}

test('排序: 相关块排第一且降序（fixture 多块防真空）', () => {
  const chunks = [
    mkChunk('a › 无关', '完全无关正文'),
    mkChunk('a › 沙箱写入 overlay', '沙箱写入 overlay 子进程看不到'),
    mkChunk('a › 另一无关', '另一段无关文本'),
    mkChunk('a › 沙箱写入补充', '沙箱写入补充，overlay 相关'),
  ]
  const r = rankDocChunks('沙箱写入 overlay', chunks, 2)
  assert.ok(r.length >= 1)
  assert.ok(r[0].title.includes('沙箱写入'), '最相关须第一')
  for (let i = 1; i < r.length; i++) assert.ok(r[i - 1].score >= r[i].score)
})

test('排序变异承重: 取反则无关块会被选中', () => {
  const chunks = [
    mkChunk('a › 无关', '无关正文'),
    mkChunk('a › 沙箱写入 overlay', '沙箱写入 overlay 子进程不可见'),
  ]
  const r = rankDocChunks('沙箱写入', chunks, 1)
  assert.ok(r[0].title.includes('沙箱写入'))
})

test('空查询 / 零命中 → []', () => {
  const chunks = [mkChunk('a › x', '正文')]
  assert.deepEqual(rankDocChunks('', chunks, 3), [])
  assert.deepEqual(rankDocChunks('qqqzzzxxx', chunks, 3), [])
})
