// [tmp-reaper-v1] 守卫：.ai-runner/tmp 下过期运行产物必须被清理。
// [WHY] /run 只 unlink 当前 runId 的 overlay，toolLog 作为自检证据刻意保留；
//   崩溃/SIGKILL 遗留的过期文件无人清理（实测累积 8444 个），目录单调增长。
// [判据承重] 删掉 reapStaleTmp 的 mtime 判定 ⇒ 本用例必红（见变异验证）。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

test('reapStaleTmp: 过期产物被删，新鲜产物与无关文件保留', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'air-reaper-'))
  const tmp = path.join(root, '.ai-runner', 'tmp')
  fs.mkdirSync(tmp, { recursive: true })
  const old = Date.now() - 8 * 24 * 3600 * 1000
  const mk = (name: string, ageMs: number) => {
    const p = path.join(tmp, name)
    fs.writeFileSync(p, 'x')
    fs.utimesSync(p, new Date(ageMs), new Date(ageMs))
    return p
  }
  const o1 = mk('1000-overlay.json', old)
  const o2 = mk('1001-tools.jsonl', old)
  const o3 = mk('1002-tools.jsonl', old)
  const fresh = mk('1003-overlay.json', Date.now())
  const unrelated = mk('probe.mjs', old)

  const prevRoot = process.env.AI_RUNNER_ROOT
  process.env.AI_RUNNER_ROOT = root
  try {
    const mod = await import('../src/state/snapshot.js')
    const removed = mod.reapStaleTmp()
    assert.equal(removed, 3, `应删 3 个过期产物，实删 ${removed}`)
    assert.equal(fs.existsSync(o1), false, '过期 overlay 必须删除')
    assert.equal(fs.existsSync(o2), false, '过期 tools 必须删除')
    assert.equal(fs.existsSync(o3), false, '过期 tools 必须删除')
    assert.equal(fs.existsSync(fresh), true, '新鲜产物不得误删')
    assert.equal(fs.existsSync(unrelated), true, '非运行产物（probe.mjs）不得误删')
  } finally {
    if (prevRoot === undefined) delete process.env.AI_RUNNER_ROOT
    else process.env.AI_RUNNER_ROOT = prevRoot
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// [tmp-reaper-runid-v2] 承重用例：按 runId 前缀识别，而非枚举后缀。
// [判据承重] 把选择器改回 "只认 -overlay.json / -tools.jsonl" ⇒ 本用例必红：
//   新类型产物（-frames.bin）不匹配任何旧后缀，只有前缀判定能删它。
test('reapStaleTmp: runId 前缀覆盖新类型产物，且不误删用户手放文件', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'air-reaper-v2-'))
  const tmp = path.join(root, '.ai-runner', 'tmp')
  fs.mkdirSync(tmp, { recursive: true })
  const old = Date.now() - 8 * 24 * 3600 * 1000
  const mk = (name: string, ageMs: number) => {
    const p = path.join(tmp, name)
    fs.writeFileSync(p, 'x')
    fs.utimesSync(p, new Date(ageMs), new Date(ageMs))
    return p
  }
  // 真实 runId 形态：13 位时间戳 + 4 位 base36
  const newType = mk('1792247404191-hl83-frames.bin', old)
  const newOverlay = mk('1792247404191-hl83-overlay.json', old)
  const freshRun = mk('1792249999999-aaaa-frames.bin', Date.now())
  // 用户手放：不匹配 runId 前缀，永不清
  const tool = mk('moli.tar.gz', old)
  const probe = mk('probe.mjs', old)

  const prevRoot = process.env.AI_RUNNER_ROOT
  process.env.AI_RUNNER_ROOT = root
  try {
    const mod = await import('../src/state/snapshot.js')
    const removed = mod.reapStaleTmp()
    assert.equal(removed, 2, `应删 2 个过期 runId 产物（含新类型），实删 ${removed}`)
    assert.equal(fs.existsSync(newType), false, '新类型产物（非旧后缀）必须按前缀删除')
    assert.equal(fs.existsSync(newOverlay), false, '旧后缀同样按前缀删除')
    assert.equal(fs.existsSync(freshRun), true, '新鲜 runId 产物不得误删')
    assert.equal(fs.existsSync(tool), true, '用户手放的 tar.gz 不得误删')
    assert.equal(fs.existsSync(probe), true, '用户手放的探针脚本不得误删')
  } finally {
    if (prevRoot === undefined) delete process.env.AI_RUNNER_ROOT
    else process.env.AI_RUNNER_ROOT = prevRoot
    fs.rmSync(root, { recursive: true, force: true })
  }
})
