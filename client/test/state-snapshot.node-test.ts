// AIRUNNER-BATCH22-1-CONSOLIDATE: 从 src/state/snapshot.node-test.ts 迁至 client/test/state-snapshot.node-test.ts
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

// AIRUNNER_CHARACTERIZATION_SNAPSHOT_V1

const TMP = path.join(process.cwd(), '.ai-runner/tmp/snap-fixture')

function useTmp(): void {
  fs.mkdirSync(TMP, { recursive: true })
  process.env.AI_RUNNER_ROOT = TMP
}

function mkMeta(ino: number, mtimeMs: number, size: number) {
  return { ino, mtimeMs, size } as unknown as import('../../src/state/snapshot.ts').FileMeta
}

function writeFixture(rel: string, content: string): void {
  const full = path.join(TMP, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf8')
}

test('snapshot: isExcluded .ai-runner prefix', async () => {
  const { isExcluded } = await import('../../src/state/snapshot.ts')
  assert.equal(isExcluded('.ai-runner/state.json'), true)
  assert.equal(isExcluded('.ai-runner'), true)
})

test('snapshot: isExcluded node_modules / .git / dist', async () => {
  const { isExcluded } = await import('../../src/state/snapshot.ts')
  assert.equal(isExcluded('node_modules/foo'), true)
  assert.equal(isExcluded('a/node_modules/b'), true)
  assert.equal(isExcluded('.git/HEAD'), true)
  assert.equal(isExcluded('dist/index.js'), true)
})

test('snapshot: isExcluded normal files -> false', async () => {
  const { isExcluded } = await import('../../src/state/snapshot.ts')
  assert.equal(isExcluded('src/index.ts'), false)
  assert.equal(isExcluded('README.md'), false)
})

test('snapshot: diffMeta empty -> []', async () => {
  const { diffMeta } = await import('../../src/state/snapshot.ts')
  const r = diffMeta(new Map(), new Map(), new Map())
  assert.deepEqual(r, [])
})

test('snapshot: diffMeta added reads disk + counts lines', async () => {
  useTmp()
  const NL = String.fromCharCode(10)
  writeFixture('new.ts', `a${NL}b`)
  const { diffMeta } = await import('../../src/state/snapshot.ts')
  const before = new Map<string, string>()
  const bMeta = new Map<string, ReturnType<typeof mkMeta>>()
  const aMeta = new Map([['new.ts', mkMeta(1, 1, 3)]])
  const r = diffMeta(before, bMeta as never, aMeta as never)
  assert.equal(r.length, 1)
  assert.equal(r[0].path, 'new.ts')
  assert.equal(r[0].type, 'added')
  assert.equal(r[0].afterLines, 2)
})

test('snapshot: diffMeta deleted', async () => {
  useTmp()
  const { diffMeta } = await import('../../src/state/snapshot.ts')
  const before = new Map<string, string>()
  const bMeta = new Map([['gone.ts', mkMeta(1, 1, 1)]])
  const aMeta = new Map<string, ReturnType<typeof mkMeta>>()
  const r = diffMeta(before, bMeta as never, aMeta as never)
  assert.deepEqual(r, [{ path: 'gone.ts', type: 'deleted' }])
})

test('snapshot: diffMeta modified when meta and content change', async () => {
  useTmp()
  const NL = String.fromCharCode(10)
  writeFixture('mod.ts', `new line 1${NL}new line 2`)
  const { diffMeta } = await import('../../src/state/snapshot.ts')
  const before = new Map([['mod.ts', 'old content']])
  const bMeta = new Map([['mod.ts', mkMeta(1, 100, 11)]])
  const aMeta = new Map([['mod.ts', mkMeta(1, 200, 22)]])
  const r = diffMeta(before, bMeta as never, aMeta as never)
  assert.equal(r.length, 1)
  assert.equal(r[0].type, 'modified')
  assert.equal(r[0].afterLines, 2)
})

test('snapshot: diffMeta meta change but same content -> []', async () => {
  useTmp()
  writeFixture('same.ts', 'unchanged')
  const { diffMeta } = await import('../../src/state/snapshot.ts')
  const before = new Map([['same.ts', 'unchanged']])
  const bMeta = new Map([['same.ts', mkMeta(1, 100, 9)]])
  const aMeta = new Map([['same.ts', mkMeta(1, 200, 9)]])
  const r = diffMeta(before, bMeta as never, aMeta as never)
  assert.deepEqual(r, [])
})

test('snapshot: diffMeta sorted by path', async () => {
  useTmp()
  writeFixture('b.ts', 'b')
  const { diffMeta } = await import('../../src/state/snapshot.ts')
  const before = new Map([['z.ts', 'old z']])
  const bMeta = new Map([['z.ts', mkMeta(1, 1, 1)]])
  const aMeta = new Map([['a.ts', mkMeta(1, 1, 1)], ['b.ts', mkMeta(1, 1, 1)]])
  const r = diffMeta(before, bMeta as never, aMeta as never)
  assert.deepEqual(r.map(x => x.path), ['a.ts', 'b.ts', 'z.ts'])
})

test('snapshot: runDir joins correctly', async () => {
  useTmp()
  const { runDir } = await import('../../src/state/snapshot.ts')
  const d = runDir('run-test-1')
  assert.ok(d.includes('.ai-runner'))
  assert.ok(d.endsWith('run-test-1'))
})

test('snapshot: readManifest missing -> null', async () => {
  useTmp()
  const { readManifest } = await import('../../src/state/snapshot.ts')
  const r = readManifest('__no_such_run__')
  assert.equal(r, null)
})

test('snapshot: saveSnapshot + readManifest roundtrip', async () => {
  useTmp()
  const { saveSnapshot, readManifest } = await import('../../src/state/snapshot.ts')
  const before = new Map([['src/x.ts', 'old x']])
  const changes = [{ path: 'src/x.ts', type: 'modified' as const, afterLines: 3 }]
  saveSnapshot('run-rt-1', before, changes as never)
  const m = readManifest('run-rt-1')
  assert.ok(m)
  assert.equal(m.changes.length, 1)
  assert.equal(m.changes[0].path, 'src/x.ts')
  assert.equal(m.changes[0].type, 'modified')
  assert.ok(typeof m.createdAt === 'number')
})
