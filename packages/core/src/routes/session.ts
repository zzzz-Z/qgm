// [repl-session-route-v1] POST/DELETE /session —— 持久 REPL 会话生命周期端点。
import { Hono } from 'hono'
import { closeSession, createSession, getSession, isSessionDegraded, reclaimIdleSessions, touchSession } from '../process/session-manager.js'
import { applyOverlay } from '../post-run/overlay.js'

/** session 路由 Hono 实例 */
export const sessionHono = new Hono()
/** POST /session：创建 REPL 会话，body { sandbox? }。 */
sessionHono.post('/session', async (c) => {
  const body = await c.req.json().catch(() => null) as { sandbox?: string } | null
  const raw = String(body?.sandbox || 'read-only')
  const sandbox = ['read-only', 'workspace-write', 'full'].includes(raw) ? raw : 'read-only'
  const info = createSession(sandbox)
  // [repl-idle-reclaim-v1] 惰性回收：建新会话时顺手清掉超时未动的旧会话（含 degraded），
  // 无需独立定时器；调用方不感知被回收的 sid，只在这里点火。
  void reclaimIdleSessions().catch(() => { /* 回收失败不阻断 create */ })
  return c.json({ ok: true, ...info })
})
/** POST /session/:sid/frame：执行一帧代码，等结果帧。 */
sessionHono.post('/session/:sid/frame', async (c) => {
  const sid = String(c.req.param('sid') || '')
  const entry = getSession(sid)
  // [repl-no-session-nextstep-v1] 404 的 nextStep 必须独立撰写，不得照抄 410：
  //   410 场景是「进程死、overlay 尚在」→ DELETE 有意义；404 场景是「sid 从未存在 or 已被空闲回收」，
  //   overlay 早已 unlink，DELETE 恒返 false（A 侧实测 A_DELETE_AFTER_RECLAIM=false）。照抄会把 P2-1 的坑从 410 搬到 404。
  //   error 字段保持 NO_SESSION 不变（全仓无程序消费方，纯新增 nextStep 零兼容风险）。
  // [repl-nextstep-gate-v1] 消费方准入门槛：任何读 nextStep 的代码，PR 必须附 404/410 各自语义的文档——
  //   当前无消费方，故不写 SYSTEM.md（那是执行方契约，不是调用方文档）；首个消费方出现时在其 PR 里写。
  if (!entry) return c.json({ ok: false, error: 'NO_SESSION', nextStep: '该 sid 从未创建或已被空闲回收，无需 DELETE，直接 POST /session 建新会话继续' }, 404)
  // [repl-degraded-v1] 会话在表里但子进程已死：用 410 与 5xx「脚本运行时错」区分开。
  // [WHY] 500 无法让调用方判断是重发脚本还是重建会话；410 Gone 语义即「资源曾存在、现已不可用」。
  // [repl-degraded-order-v1] 本判定刻意排在 EMPTY_CODE 之前：已死会话 + 空代码返 410 而非 400 ——
  //   「会话已死」是更根本的状态，先修会话才轮得到参数校验。调换顺序会让已死会话返 400，
  //   调用方会误当参数错去重写脚本，而不是重建会话。此顺序无测试覆盖，故注释钉死。
  // [repl-recover-steps-v1] recoverable 必须配可执行步骤，否则「重建会话」是空承诺：
  //   POST /session 不接受 sid（那是 S6-2 的活），旧 degraded entry 需显式 DELETE 才能回收 overlay/toolLog。
  if (isSessionDegraded(sid)) {
    return c.json({
      ok: false,
      code: 'REPL_DEAD',
      recoverable: true,
      sid,
      nextStep: `POST /session 建新会话继续；旧 sid 需 DELETE /session/${sid} 以回收 overlay/toolLog`,
    }, 410)
  }
  const body = await c.req.json().catch(() => null) as { code?: string, id?: string } | null
  const code = String(body?.code || '')
  if (!code) return c.json({ ok: false, error: 'EMPTY_CODE' }, 400)
  // [repl-idle-reclaim-v1] 帧端点即活跃信号：立即刷新 lastActiveAt，防长任务被误杀
  touchSession(sid)
  try {
    entry.handle.send({ id: body?.id, code })
    const frame = await entry.handle.nextFrame(60000)
    // [repl-apply-overlay-v1] 帧末把 overlay 落盘（复用 /run:183 的语义）。
    // [INVARIANT] read-only 的 overlay 永不 apply —— 其写入是「该被丢弃」的（拦截器不 bypass 不 reject，
    //   只进 overlay），无条件 apply 会把本该丢弃的越界写真的落盘（A 侧实测判据 D 为证）。
    // [INVARIANT] workspace-write 下本分支当前是 no-op：拦截器 `sandboxBypass` 对根内路径直接真写盘，
    //   故 overlay 恒空、`applyOverlay` 的 `applied` 恒为 0。它不是行为修复，是「潜伏风险硬化」——
    //   一旦 bypass 规则变化（如改为 staged writes），本门控即成承重路径。
    // [CHANGE-IMPACT] A 侧实测双实例：新旧产物端到端探针 18/18 逐条相同，净效果 = 0；门控承重性见守卫测试。
    if (entry.sandbox === 'workspace-write') {
      try { applyOverlay(entry.overlayPath) } catch { /* apply 失败不阻断帧返回 */ }
    }
    return c.json({ ok: true, frame })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return c.json({ ok: false, error: msg }, 500)
  }
})
/** DELETE /session/:sid：关闭会话，幂等。 */
sessionHono.delete('/session/:sid', async (c) => {
  const sid = String(c.req.param('sid') || '')
  const ok = await closeSession(sid)
  return c.json({ ok, sid })
})
