// [board-pending-v1] 只读清点仪器的承重判据（5 条，各配一组变异，改后必红）。
// [WHY] 本仪器存在的理由是「pending 无 TTL ⇒ 泄漏不可见」。判据必须钉住它**只报不修**、
//   且**不误报**（时刻未知不判过期、全 done 桶不产出），否则它会变成第二个假信号源。
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'vitest'
import assert from 'node:assert/strict'

interface Item { id: string, desc: string, status: string, createdAt?: number, startedAt?: number }
interface View {
  buckets: Array<{
    sid: string
    pending: number
    running: number
    stale: number
    items: Array<{ id: string, status: string, desc: string, ageMs: number | null, stale: boolean, selfHealDue: boolean }>
  }>
  totalOpen: number
  totalStale: number
  totalSelfHealDue: number
}

const require_ = createRequire(import.meta.url)
const { computePending, readBuckets } = require_('../../../scripts/board-pending.cjs') as {
  computePending: (bySid: Record<string, { items?: Item[] }>, now: number, staleMs?: number) => View
  readBuckets: (root: string) => Record<string, { items?: Item[] }>
}

const H = 3600_000
const NOW = 1_700_000_000_000
const STALE = 2 * H
function mk(id: string, status: string, ageMs: number, desc = ''): Item {
  return {
    id,
    desc: desc || `${status}-${id}`,
    status,
    ...(status === 'running' ? { startedAt: NOW - ageMs } : { createdAt: NOW - ageMs }),
  }
}

// G1 变异：把 `ageMs > staleMs` 改成恒 false（或去阈值）⇒ 本例红
test('G1 超阈标记：age > 阈值 ⇒ stale，age ≤ 阈值 ⇒ 不 stale', () => {
  const v = computePending({ s: { items: [mk('a', 'pending', 3 * H), mk('b', 'pending', 1 * H)] } }, NOW, STALE)
  assert.equal(v.buckets.length, 1)
  assert.equal(v.buckets[0].stale, 1, '恰一条超阈')
  assert.equal(v.totalStale, 1)
  const a = v.buckets[0].items.find(x => x.id === 'a')
  const b = v.buckets[0].items.find(x => x.id === 'b')
  assert.equal(a?.stale, true, '3h > 2h 应判 stale')
  assert.equal(b?.stale, false, '1h < 2h 不得判 stale')
})

// G2 变异：把 running 也算进 pending 计数 ⇒ 本例红
test('G2 running 与 pending 分列，不混算', () => {
  const v = computePending({ s: { items: [mk('p', 'pending', H), mk('r', 'running', H)] } }, NOW, STALE)
  assert.equal(v.buckets[0].pending, 1, 'pending 只数 pending')
  assert.equal(v.buckets[0].running, 1, 'running 单独计')
  assert.equal(v.totalOpen, 2, '未收口总数含两类')
})

// G3 变异：去掉 `if (!open.length) continue`（done-only 桶也产出）⇒ 本例红
test('G3 只列含未收口项的桶；全 done / 空桶不产出', () => {
  const v = computePending({
    A: { items: [mk('a', 'pending', H)] },
    B: { items: [{ id: 'b', desc: 'done-b', status: 'done' }] },
    C: { items: [] },
    D: {},
  }, NOW, STALE)
  assert.equal(v.buckets.length, 1, '只有一个桶有未收口项')
  assert.equal(v.buckets[0].sid, 'A')
  assert.equal(v.totalOpen, 1)
})

// G4 变异：把 `ageMs !== null &&` 去掉（0 当过期）⇒ 本例红
test('G4 时刻未知（createdAt=0/缺省）不判 stale，但仍在清单里', () => {
  const v = computePending({ s: { items: [{ id: 'u', desc: '时刻未知项', status: 'pending', createdAt: 0 }, { id: 'n', desc: '无时刻字段', status: 'pending' }] } }, NOW, STALE)
  assert.equal(v.totalOpen, 2, '未知时刻不是「不收口」，仍要列出')
  assert.equal(v.totalStale, 0, '未知时刻不得判 stale')
  assert.ok(v.buckets[0].items.every(x => x.ageMs === null && x.stale === false))
})

// G5 变异：把 readBuckets 的结果提到模块顶层缓存 ⇒ 第二段断言红
test('G5 readBuckets 按 root 现读（无顶层缓存、--root 可注入）', () => {
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'board-pending-A-'))
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'board-pending-B-'))
  try {
    for (const [root, sid] of [[rootA, 'sid-A'], [rootB, 'sid-B']] as const) {
      fs.mkdirSync(path.join(root, '.ai-runner'), { recursive: true })
      fs.writeFileSync(
        path.join(root, '.ai-runner', 'state.json'),
        JSON.stringify({ tasksBySid: { [sid]: { items: [{ id: 'x', desc: 'x', status: 'pending', createdAt: NOW }] } } }),
        'utf8',
      )
    }
    const a = readBuckets(rootA)
    const b = readBuckets(rootB)
    assert.deepEqual(Object.keys(a), ['sid-A'], '第一次读 rootA')
    assert.deepEqual(Object.keys(b), ['sid-B'], '第二次必须读到 rootB —— 若为 [sid-A] 即为顶层缓存（判据真空）')
    assert.deepEqual(readBuckets(path.join(rootA, 'nope')), {}, 'root 缺 state.json ⇒ 空桶，不抛')
  } finally {
    fs.rmSync(rootA, { recursive: true, force: true })
    fs.rmSync(rootB, { recursive: true, force: true })
  }
})

// G6 变异：把 RUNNING_TIMEOUT_MS 提到 2h、或让 selfHealDue 恒 false ⇒ 本例红
test('G6 盘上 running 超 30min ⇒ selfHealDue；pending 无此机制、永不置位', () => {
  const v = computePending({ s: { items: [mk('r', 'running', 45 * 60000), mk('p', 'pending', 45 * 60000)] } }, NOW, STALE)
  const r = v.buckets[0].items.find(x => x.id === 'r')
  const p = v.buckets[0].items.find(x => x.id === 'p')
  assert.equal(r?.selfHealDue, true, 'running 45min > 30min 自愈阈值')
  assert.equal(p?.selfHealDue, false, 'pending 无自愈机制，不得置位 —— 这正是本单要说清的不对称')
  assert.equal(v.totalSelfHealDue, 1)
  assert.equal(v.totalStale, 0, '45min < 2h 阈值，两者口径互不串台')
})
