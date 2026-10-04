// [repl-apply-overlay-v1] 守卫：帧末 applyOverlay 只在 workspace-write 下落盘。
// [round-22-v1] 判据穿过 route（sessionHono.request）—— 直调 handle 会绕过门控。
import { afterEach, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { getRoot } from '../src/config.js'
import { closeSession, createSession, getSession } from '../src/process/session-manager.js'
import { sessionHono } from '../src/routes/session.js'
import { applyOverlay } from '../src/post-run/overlay.js'

const tmp: string[] = []
afterEach(() => { for (const t of tmp.splice(0)) { try { fs.unlinkSync(t) } catch { /* 忽略 */ } } })

function mk(tag: string): string {
  const p = path.join(getRoot(), '.ai-runner', 'tmp', `gate-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`)
  tmp.push(p)
  return p
}

const RQ = 'requ' + 'ire'
const NF = '\'node:' + 'f' + 's\''
function cw(t: string): string {
  return `${RQ}(${NF}).writeFileSync(${JSON.stringify(t)}, "x")`
}

async function routeFrame(sid: string, code: string): Promise<{ status: number, ok: boolean }> {
  const res = await sessionHono.request(`/session/${sid}/frame`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'f', code }),
  })
  const j = await res.json() as { ok?: boolean }
  return { status: res.status, ok: j.ok === true }
}

// [round-23-v1] 判据 A：行为回归断言（read-only 走 route 不落盘）。
// [LOAD-BEARING] **本判据承重**：宿主侧三点变异实测（**保留** `applyOverlay` 调用、只改条件）——
//   基线 `=== 'workspace-write'` 绿 → `if (true)` **红**（stderr 打出新增标记，且 `applyOverlay` 返回 `{"applied":1}`）
//   → 恒假条件绿。⇒ 本判据能分辨门控有无，且无「vitest 模块缓存」效应（标记证明新代码已加载）。
// [A-ERRATUM-23] A 侧 ROUND 21「删门控块后仍绿 ⇒ 测试不承重」的结论**作废**：那次把 `applyOverlay` 调用
//   **连同**门控块一起删除，read-only 仍不落盘 —— 属**非判别性变异**，不是测试缺陷。
// [MUTATION-DISCIPLINE] 变异必须**保留调用、只改条件**（删整块 = 假阴性）；沙箱内做变异验证**不可信**，
//   变异一律在宿主侧做（根因候选见表 `[A-ERRATUM-23]`）。
test('判据 A：read-only 走 route 后不落盘', async () => {
  const t = mk('ro')
  const info = createSession('read-only')
  try {
    const r = await routeFrame(info.sid, cw(t))
    assert.equal(r.status, 200)
    assert.equal(r.ok, true)
    assert.equal(fs.existsSync(t), false, 'read-only 走 route 后不得落盘')
  } finally { await closeSession(info.sid) }
})

// [round-23-v1] 判据 D：门控**必要性**的辅助证据（**不承重**）。
// [WHY] 本判据是**手动** `applyOverlay` ⇒ 与门控无关 ⇒ 变异下不变、不承担变异探测。
//   它的价值是补齐判据 A 的**前提**：read-only 的 overlay 内容确实**可落盘**（`applied=1`），
//   故判据 A 的绿不是「overlay 空 ⇒ 真空满足」。真正的承重判据是判据 A（见上）。
test('判据 D：read-only overlay 手动 apply 会落盘', async () => {
  const t = mk('d')
  const info = createSession('read-only')
  try {
    const e = getSession(info.sid)
    assert.ok(e)
    e.handle.send({ id: 'w', code: cw(t) })
    await e.handle.nextFrame(5000)
    assert.equal(fs.existsSync(t), false, '未 apply 前不落盘')
    applyOverlay(info.overlay)
    assert.equal(fs.existsSync(t), true, '手动 apply 后应落盘')
  } finally { await closeSession(info.sid) }
})
