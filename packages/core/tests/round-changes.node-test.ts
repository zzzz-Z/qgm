// [round-changes-v1] 守卫 /run-changes（本轮视图的权威兜底端点）
//
// 背景：本轮视图原本只有「浏览器 summary 帧的 changes」这一条数据源，那一帧没被接住时本轮恒为空，
//   而累积走独立磁盘 diff 照常有数据 —— 用户看到「本轮永远空」却无法自解释。本端点改从服务端
//   每轮落盘的 run manifest 取数，是比 summary 更权威、且不依赖累积基准的源。
//
// 本文件钉住四件事：
//   ① 显式 runId → 返回**该轮**自己的 changes（单轮语义，不是累积子集）；
//   ② runId 缺省 → 返回**最新一轮**（按 createdAt 升序取末项，不是按目录名字典序）；
//   ③ 未知 runId / 无历史运行 → ok:false + changes: []（静默降级，不抛、不用 4xx 制造噪音）；
//   ④ 只读：不得因探测而改写任何 manifest。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, test } from 'vitest'

import { getRoot, setRoot } from '../src/config.js'
import { filesHono } from '../src/routes/files.js'
import { runDir } from '../src/state/snapshot.js'

const ORIG_ROOT = getRoot()
let TMP: string

/** 在 runs/ 下造一轮 manifest（与 saveSnapshot 落盘格式一致：{ changes, createdAt }） */
function writeRun(runId: string, createdAt: number, changes: Array<{ path: string, type: string }>): string {
  const dir = runDir(runId)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, '_manifest.json')
  fs.writeFileSync(file, JSON.stringify({ changes, createdAt }, null, 2))
  return file
}

/** 调一次 /run-changes */
async function call(body: unknown): Promise<Record<string, unknown>> {
  const res = await filesHono.request('/run-changes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  assert.equal(res.status, 200, '兜底端点不得用非 200 表达「没记录」——调用方要能静默降级')
  return await res.json() as Record<string, unknown>
}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'round-changes-'))
  setRoot(TMP)
})

afterEach(() => {
  setRoot(ORIG_ROOT)
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
})

test('显式 runId：返回该轮自己的 changes（单轮语义）', async () => {
  writeRun('1791520000000-aaaa', 1000, [
    { path: 'src/a.ts', type: 'modified' },
    { path: 'src/b.ts', type: 'added' },
  ])
  const j = await call({ runId: '1791520000000-aaaa' })
  assert.equal(j.ok, true)
  assert.equal(j.runId, '1791520000000-aaaa')
  assert.deepEqual(j.changes, [
    { path: 'src/a.ts', type: 'modified' },
    { path: 'src/b.ts', type: 'added' },
  ], '必须是该 run manifest 的原始改动，不得退化成累积口径')
})

test('runId 缺省：返回最新一轮 —— 按 createdAt 判定，而非目录名字典序', async () => {
  // 刻意让「名字更大」的那轮 createdAt 更小：若实现按字典序取末项就会选错
  writeRun('1791520000000-zzzz', 1000, [{ path: 'src/older.ts', type: 'modified' }])
  writeRun('1791520000001-aaaa', 2000, [{ path: 'src/newest.ts', type: 'added' }])
  const j = await call({})
  assert.equal(j.ok, true)
  assert.equal(j.runId, '1791520000001-aaaa', '应按 createdAt 升序取末项，而非名字排序')
  assert.deepEqual(j.changes, [{ path: 'src/newest.ts', type: 'added' }])
})

test('未知 runId / 无历史运行：ok:false + changes 空数组（静默降级）', async () => {
  const j1 = await call({ runId: '2099010100000-nope' })
  assert.equal(j1.ok, false, 'manifest 缺失不得报成功')
  assert.deepEqual(j1.changes, [], '降级时必须给空数组，调用方才能无分支处理')

  const j2 = await call({})
  assert.equal(j2.ok, false, '尚无历史运行不得报成功')
  assert.deepEqual(j2.changes, [])
})

test('只读：探测不得改写任何 manifest', async () => {
  const file = writeRun('1791520000000-keep', 1000, [{ path: 'src/x.ts', type: 'modified' }])
  const before = fs.readFileSync(file, 'utf8')
  await call({ runId: '1791520000000-keep' })
  await call({})
  assert.equal(fs.readFileSync(file, 'utf8'), before, '兜底端点是只读探测，不得改写 manifest')
})
