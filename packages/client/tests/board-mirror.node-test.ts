// [board-mirror-v1] 看板常驻上下文的承重测试
// [WHY] 2026-10-08 实测：AI 跑 21 个脚本全部成功、看板 0/7 冻结（脚本执行与看板零联动）。
//   本文件锁住「每轮回传都把未完成任务（带 id）递到 AI 面前」这一修复，防止回传链路重构时静默退化。
import { test } from 'vitest'
import assert from 'node:assert'
import fs from 'node:fs'
import {
  BOARD_REGISTER_HINT,
  BOARD_STALE_ROUNDS,
  boardStaleStreak,
  fetchBoardMirror,
  formatBoardMirror,
  resetBoardMirror,
} from '../composables/ai/board-mirror.js'

function read(p: string): string {
  return fs.readFileSync(p, 'utf8')
}

test('① 未完成任务清单带 id 渲染，并含 start / complete / fail 三条规则', () => {
  const out = formatBoardMirror([
    { id: 'a1b2', desc: '下沉文件系统族', status: 'pending' },
    { id: 'c3d4', desc: '同步构建拷贝清单', status: 'running' },
    { id: 'e5f6', desc: '已完成的旧任务', status: 'done' },
  ])
  assert.ok(out.includes('未完成 2 项（已完成 1）'), '计数行必须区分未完成与已完成')
  assert.ok(out.includes('a1b2 | 下沉文件系统族'), 'pending 项必须带 id 原样输出')
  assert.ok(out.includes('c3d4 | 同步构建拷贝清单 · 执行中'), 'running 项须标注执行中')
  assert.ok(!out.includes('已完成的旧任务'), '已完成项不得进清单')
  assert.ok(out.includes('__AI__.tasks.start([id])'), '必须教 start')
  assert.ok(out.includes('__AI__.tasks.complete([id])'), '必须教 complete')
  assert.ok(out.includes('__AI__.tasks.fail([id])'), '必须教 fail（失败态显式化）')
})

test('② 反例：无未完成任务 ⇒ 空串（简单轮 / 收尾轮不打扰）', () => {
  assert.equal(formatBoardMirror([{ id: 'x', desc: 'done 项', status: 'done' }]), '')
  assert.equal(formatBoardMirror([]), '')
  assert.equal(formatBoardMirror([{ id: 'y', desc: '   ', status: 'pending' }]), '')
})

test('③ 停滞告警：连续 N 轮指纹不变才升级为警告，首轮不警告', async () => {
  resetBoardMirror()
  const items = [{ id: 'a1', desc: '任务 A', status: 'pending' }]
  const g = globalThis as unknown as { fetch?: unknown }
  const orig = g.fetch
  g.fetch = (async () => ({ ok: true, json: async () => ({ items }) })) as unknown as typeof fetch
  try {
    const r1 = await fetchBoardMirror('sid-1')
    assert.ok(r1.includes('任务 A'), '首轮应渲染清单')
    assert.ok(!r1.includes('连续'), '首轮不得告警（无上一轮可比）')
    await fetchBoardMirror('sid-1')
    assert.equal(boardStaleStreak(), 1, '第二次同指纹 ⇒ 停滞 1')
    await fetchBoardMirror('sid-1')
    const r3 = await fetchBoardMirror('sid-1')
    assert.ok(r3.includes(`连续 ${BOARD_STALE_ROUNDS} 轮看板状态未变化`), '达阈值必须告警')
  } finally {
    g.fetch = orig
    resetBoardMirror()
  }
})

test('④ 反例：指纹变化（有任务被推进）⇒ 停滞清零、不告警', async () => {
  resetBoardMirror()
  const g = globalThis as unknown as { fetch?: unknown }
  const orig = g.fetch
  let n = 0
  g.fetch = (async () => ({
    ok: true,
    json: async () => ({
      items: n++ < 2
        ? [{ id: 'a1', desc: '任务 A', status: 'pending' }]
        : [{ id: 'a1', desc: '任务 A', status: 'done' }],
    }),
  })) as unknown as typeof fetch
  try {
    await fetchBoardMirror('sid-2')
    await fetchBoardMirror('sid-2')
    assert.equal(boardStaleStreak(), 1)
    const r3 = await fetchBoardMirror('sid-2')
    assert.equal(r3, '', '全部完成 ⇒ 空串')
    assert.equal(boardStaleStreak(), 0, '指纹变化（或无未完成）⇒ 停滞清零')
  } finally {
    g.fetch = orig
    resetBoardMirror()
  }
})

test('⑤ 反例：抓取失败 / sid 为空 ⇒ 空串，绝不阻断回传', async () => {
  resetBoardMirror()
  const g = globalThis as unknown as { fetch?: unknown }
  const orig = g.fetch
  g.fetch = (async () => { throw new Error('network down') }) as unknown as typeof fetch
  try {
    assert.equal(await fetchBoardMirror('sid-3'), '')
  } finally {
    g.fetch = orig
    resetBoardMirror()
  }
  assert.equal(await fetchBoardMirror(''), '', 'sid 为空直接返回空串')
})

test('[P3d] ⑥ 注入点锚点：面板回传真的调用了看板注入（含空看板登记提醒）', () => {
  // [loop-consolidation-P3d] 原「循环回传」分支断言随 auto-loop/loop-lessons-fill.ts 删除；
  //   留存路径的面板回传注入不变。
  const panel = read('packages/client/components/script/script-panel-actions.ts')
  assert.ok(panel.includes('await fetchBoardMirror('), '面板回传必须注入看板块')
  assert.ok(panel.includes('remindRegister: true'), '面板回传必须开启空看板登记提醒（board-register-hint-v1）')
  assert.ok(panel.includes('from \'../../composables/ai/board-mirror\''), '面板回传须显式 import')
})

// [board-register-hint-v1] 看板空 + 本轮在跑脚本 ⇒ 注入登记提醒（2026-10-20 plus-ui 实证的根因修复）
test('⑧ 登记提醒：抓到空看板且 remindRegister ⇒ 返回提示；默认关、抓取失败不提示', async () => {
  resetBoardMirror()
  const g = globalThis as unknown as { fetch?: unknown }
  const orig = g.fetch
  g.fetch = (async () => ({ ok: true, json: async () => ({ items: [] }) })) as unknown as typeof fetch
  try {
    const hint = await fetchBoardMirror('sid-hint', { remindRegister: true })
    assert.ok(hint.includes('任务看板 · 空'), '空看板必须返回登记提醒')
    assert.ok(hint.includes('__AI__.tasks.push('), '提醒必须教 push 登记')
    assert.ok(hint.includes('__AI__.tasks.start([id])'), '提醒必须教 start')
    assert.ok(hint.includes('__AI__.tasks.complete([id])'), '提醒必须教 complete')
    assert.ok(hint.includes('__AI__.tasks.fail([id])'), '提醒必须教 fail 收尾')
    assert.equal(hint, BOARD_REGISTER_HINT, '提示文本必须与导出常量逐字一致')
    // 全部做完（items 有终态、无未完成）同样提醒登记下一批
    const done = await fetchBoardMirror('sid-hint', { remindRegister: true })
    assert.ok(done.includes('任务看板 · 空'), '全终态看板同样提醒（登记下一批）')
    // 默认不开 ⇒ 维持空串（④ 的行为不变）
    g.fetch = (async () => ({ ok: true, json: async () => ({ items: [] }) })) as unknown as typeof fetch
    assert.equal(await fetchBoardMirror('sid-hint'), '', '不开 remindRegister 保持空串')
    // 抓取失败 ⇒ 即使开了提醒也静默（绝不阻断回传）
    g.fetch = (async () => { throw new Error('network down') }) as unknown as typeof fetch
    assert.equal(await fetchBoardMirror('sid-hint', { remindRegister: true }), '', '网络失败不得提示')
    // 非 ok 响应 ⇒ 同样静默
    g.fetch = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch
    assert.equal(await fetchBoardMirror('sid-hint', { remindRegister: true }), '', 'HTTP 非 2xx 不得提示')
  } finally {
    g.fetch = orig
    resetBoardMirror()
  }
})

test('⑦ 教学锚点：SYSTEM.md 必须写明 id 直传与失败必报', () => {
  const sys = read('packages/core/SYSTEM.md')
  assert.ok(sys.includes('board-id-direct-v1'), 'SYSTEM.md 缺 board-id-direct-v1（id 直传）')
  assert.ok(/start.*一律传.*id|一律传.*list\(\).*返回的 id/s.test(sys), 'SYSTEM.md 须写明一律传 id')
  assert.ok(sys.includes('board-fail-explicit-v1'), 'SYSTEM.md 缺 board-fail-explicit-v1（失败必报）')
  assert.ok(sys.includes('禁止沉默留在待办'), 'SYSTEM.md 须写明禁止沉默挂待办')
})
