import { describe, expect, it } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import {
  hashScript,
  listRounds,
  readRoundSnapshot,
  resolvePaths,

  writeRoundSnapshot
} from '../../packages/core/src/state/timeline'
import type { RoundSnapshot } from '../../packages/core/src/state/timeline'

function mkSnap(round: number, overrides: Partial<RoundSnapshot> = {}): RoundSnapshot {
  return {
    round,
    runId: 'run-test',
    sessionId: 'sess-test',
    ts: 1700000000000 + round,
    todo: [],
    changes: [],
    decisions: [],
    exitCode: 0,
    durationMs: 100,
    rulesVersion: 'test-v1',
    ...overrides,
  }
}

describe('timeline: resolvePaths', () => {
  it('组合 root/sessionId/runId/round 到正确路径', () => {
    const p = resolvePaths('/tmp/r', 's1', 'r1', 3)
    expect(p.dir).toBe(path.join('/tmp/r', '.ai-runner', 'runs', 's1', 'r1'))
    expect(p.roundFile).toBe(path.join(p.dir, 'round-3.json'))
    expect(p.indexPath).toBe(path.join(p.dir, '_index.json'))
  })
})

describe('timeline: writeRoundSnapshot / readRoundSnapshot', () => {
  it('写入后可读回相同内容', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-'))
    const snap = mkSnap(1)
    const file = writeRoundSnapshot(root, snap)
    expect(fs.existsSync(file)).toBe(true)
    const back = readRoundSnapshot(root, 'sess-test', 'run-test', 1)
    expect(back).not.toBeNull()
    expect(back?.round).toBe(1)
    expect(back?.sessionId).toBe('sess-test')
  })

  it('读不存在的 round 返回 null', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-'))
    const r = readRoundSnapshot(root, 'sess-x', 'run-x', 99)
    expect(r).toBeNull()
  })

  it('多次写入累积到 _index.json', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-'))
    writeRoundSnapshot(root, mkSnap(1))
    writeRoundSnapshot(root, mkSnap(2))
    writeRoundSnapshot(root, mkSnap(3))
    const idxFile = resolvePaths(root, 'sess-test', 'run-test', 0).indexPath
    const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'))
    expect(Array.isArray(idx)).toBe(true)
    expect(idx.map((e: { round: number }) => e.round)).toEqual([1, 2, 3])
  })
})

describe('timeline: listRounds', () => {
  it('空目录返回 []', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-'))
    expect(listRounds(root, 's', 'r')).toEqual([])
  })

  it('返回已写入的 round 排序列表', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-'))
    writeRoundSnapshot(root, mkSnap(2))
    writeRoundSnapshot(root, mkSnap(1))
    writeRoundSnapshot(root, mkSnap(3))
    expect(listRounds(root, 'sess-test', 'run-test')).toEqual([1, 2, 3])
  })
})

describe('timeline: hashScript', () => {
  it('相同内容 hash 相同', () => {
    expect(hashScript('abc')).toBe(hashScript('abc'))
  })

  it('不同内容 hash 不同', () => {
    expect(hashScript('abc')).not.toBe(hashScript('abd'))
  })

  it('输出 8 位 hex', () => {
    expect(hashScript('hello')).toMatch(/^[0-9a-f]{8}$/)
  })
})
