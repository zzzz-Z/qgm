// AIRUNNER-BATCH24-3-WEB-SERVER: server 侧测试（原 test/utils-index-index.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/utils-index-index.node-test.ts 迁至 test/utils-index-index.node-test.ts
// AIRUNNER-BATCH22-1-CONSOLIDATE: 从 src/utils/index-index.node-test.ts 迁至 client/test/utils-index-index.node-test.ts
// AIRUNNER-CHARACTERIZATION-INDEX-INDEX
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
// 该文件是 CJS 视角（.node-test.ts），必须动态 import

const TMP = path.join(process.cwd(), '.ai-runner/tmp/ii-fixture')

function mkFileIndex(inode: number, mtimeMs: number, size: number) {
  return { inode, mtimeMs, size } as unknown as import('../../../packages/core/src/utils/index-index.js').FileIndex
}

test(`index-index: diffIndexes 空 -> 空`, async () => {
  const { diffIndexes } = await import('../../../packages/core/src/utils/index-index.js')
  const r = diffIndexes(new Map(), new Map())
  assert.deepEqual(r, [])
})

test(`index-index: diffIndexes 新增`, async () => {
  const { diffIndexes } = await import('../../../packages/core/src/utils/index-index.js')
  const before = new Map<string, ReturnType<typeof mkFileIndex>>()
  const after = new Map([['a.ts', mkFileIndex(1, 1, 1)]])
  const r = diffIndexes(before as never, after as never)
  assert.deepEqual(r, [{ path: 'a.ts', type: 'added' }])
})

test(`index-index: diffIndexes 删除`, async () => {
  const { diffIndexes } = await import('../../../packages/core/src/utils/index-index.js')
  const before = new Map([['a.ts', mkFileIndex(1, 1, 1)]])
  const after = new Map<string, ReturnType<typeof mkFileIndex>>()
  const r = diffIndexes(before as never, after as never)
  assert.deepEqual(r, [{ path: 'a.ts', type: 'deleted' }])
})

test(`index-index: diffIndexes size 变化 -> modified`, async () => {
  const { diffIndexes } = await import('../../../packages/core/src/utils/index-index.js')
  const before = new Map([['a.ts', mkFileIndex(1, 100, 1)]])
  const after = new Map([['a.ts', mkFileIndex(1, 100, 2)]])
  const r = diffIndexes(before as never, after as never)
  assert.deepEqual(r, [{ path: 'a.ts', type: 'modified' }])
})

test(`index-index: diffIndexes mtime 变化 -> modified`, async () => {
  const { diffIndexes } = await import('../../../packages/core/src/utils/index-index.js')
  const before = new Map([['a.ts', mkFileIndex(1, 100, 1)]])
  const after = new Map([['a.ts', mkFileIndex(1, 200, 1)]])
  const r = diffIndexes(before as never, after as never)
  assert.deepEqual(r, [{ path: 'a.ts', type: 'modified' }])
})

test(`index-index: diffIndexes inode 变化 -> modified`, async () => {
  const { diffIndexes } = await import('../../../packages/core/src/utils/index-index.js')
  const before = new Map([['a.ts', mkFileIndex(1, 100, 1)]])
  const after = new Map([['a.ts', mkFileIndex(2, 100, 1)]])
  const r = diffIndexes(before as never, after as never)
  assert.deepEqual(r, [{ path: 'a.ts', type: 'modified' }])
})

test(`index-index: diffIndexes 全字段相同 -> 空`, async () => {
  const { diffIndexes } = await import('../../../packages/core/src/utils/index-index.js')
  const before = new Map([['a.ts', mkFileIndex(1, 100, 1)]])
  const after = new Map([['a.ts', mkFileIndex(1, 100, 1)]])
  const r = diffIndexes(before as never, after as never)
  assert.deepEqual(r, [])
})

test(`index-index: diffIndexes 结果按 path 排序`, async () => {
  const { diffIndexes } = await import('../../../packages/core/src/utils/index-index.js')
  const before = new Map([['z.ts', mkFileIndex(1, 1, 1)]])
  const after = new Map([['a.ts', mkFileIndex(1, 1, 1)], ['m.ts', mkFileIndex(1, 1, 1)]])
  const r = diffIndexes(before as never, after as never)
  assert.deepEqual(r.map(x => x.path), ['a.ts', 'm.ts', 'z.ts'])
  assert.deepEqual(r.map(x => x.type), ['added', 'added', 'deleted'])
})

test(`index-index: readIndex 目录不存在 -> null`, async () => {
  const { readIndex } = await import('../../../packages/core/src/utils/index-index.js')
  const r = readIndex(path.join(TMP, '__nonexistent__'))
  assert.equal(r, null)
})

test(`index-index: saveIndex + readIndex 往返一致`, async () => {
  const { saveIndex, readIndex } = await import('../../../packages/core/src/utils/index-index.js')
  fs.mkdirSync(TMP, { recursive: true })
  const idx = new Map([['a.ts', mkFileIndex(1, 100, 5)], ['b.ts', mkFileIndex(2, 200, 10)]])
  saveIndex('run-test', idx as never, TMP)
  const r = readIndex(TMP)
  assert.ok(r instanceof Map)
  assert.equal(r!.size, 2)
  assert.equal((r!.get('a.ts') as any).size, 5)
  assert.equal((r!.get('b.ts') as any).inode, 2)
})

test(`index-index: readIndex 无效 JSON -> null`, async () => {
  const { readIndex } = await import('../../../packages/core/src/utils/index-index.js')
  const bad = path.join(TMP, 'bad')
  fs.mkdirSync(bad, { recursive: true })
  fs.writeFileSync(path.join(bad, '_index.json'), 'not json {')
  const r = readIndex(bad)
  assert.equal(r, null)
})
