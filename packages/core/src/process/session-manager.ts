// [repl-session-v1] 持久 REPL 会话池：sid → ReplHandle 的注册与生命周期管理。
// [WHY] /run/session 系列端点需要共享会话状态；把状态与网络层分离，便于单测。
// [CONSTRAINT] 每 sid 一个进程；同 sid 重复 create 会先关旧进程再起新的。
// [CHANGE-IMPACT] 被 routes/session.ts 消费；改返回结构会影响所有端点。
import type { ReplHandle } from './repl-proc.js'
import { runReplProcess } from './repl-proc.js'
import { getRoot } from '../config.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** repl-loop.cjs 的绝对路径（与 repl-proc.ts 同目录的上一级） */
function replLoopPath(): string {
  return fileURLToPath(new URL('../repl-loop.cjs', import.meta.url))
}
// [repl-session-sandbox-v1] 与 auth 无关的两份运行时 cjs，路径解析口径同 post-run/run-script.ts。
// [CONSTRAINT] dist 布局下 bundle 落在 dist/_server/index.js ⇒ '../x.cjs' 命中 dist/x.cjs；
//   这两个文件由 scripts/build-all.mjs step 3 复制（见 tests/runtime-cjs-copy.node-test.ts 守卫）。
function interceptorCjsPath(): string {
  return fileURLToPath(new URL('../interceptor.cjs', import.meta.url))
}
function helpersCjsPath(): string {
  return fileURLToPath(new URL('../helpers.cjs', import.meta.url))
}

export interface SessionEntry {
  handle: ReplHandle
  sandbox: string
  createdAt: number
  lastActiveAt: number
  overlayPath: string
  toolLogPath: string
  // [repl-degraded-v1] 子进程已死：会话仍在表中，但不可再用；frame 端点须回 REPL_DEAD
  degraded: boolean
}

/** 活跃会话表；key 为 sid */
const sessions = new Map<string, SessionEntry>()

/** 会话空闲回收上限（ms）；超过则 close */
// [repl-idle-reclaim-v1] 空闲回收阈值（ms），可用 env 临时覆盖以便测试变异验证。
// [CONSTRAINT] 缺省 10min —— 不要把 60s 作为默认：AI 思考 + 网页往返可能几分钟无帧，
//   60s 会误杀在思考的会话（设计文档附问 4 的答案：用长阈值 + 帧端活跃刷新规避误杀）。
const IDLE_MAX_MS = Number(process.env.AI_RUNNER_IDLE_MAX_MS) || 10 * 60 * 1000
// [idle-max-trace-v1] 生产误设 AI_RUNNER_IDLE_MAX_MS 会静默改变会话回收阈值（过小误杀会话、
//   过大内存不释放），排查时无从定位。启动打一行即可查；本身不阻断。
if (process.env.AI_RUNNER_IDLE_MAX_MS) console.warn('[session] IDLE_MAX_MS 被 env 覆盖 =', IDLE_MAX_MS)

let _seq = 0
function newSid(): string {
  _seq += 1
  return `sess-${Date.now().toString(36)}-${_seq.toString(36)}`
}

export interface SessionInfo {
  sid: string
  sandbox: string
  pid: number | undefined
  createdAt: number
  /** overlay 落盘路径：每帧末由 repl-loop 调 __AI_FLUSH_OVERLAY 刷新 */
  overlay: string
  /** 工具调用 JSONL 日志路径 */
  toolLog: string
}

/**
 * 创建新会话（或替换同 sid 的旧会话）。
 * [CONSTRAINT] sandbox 由调用方给出，缺省 read-only。
 * [repl-session-sandbox-v1] 必须 `-r` 预加载拦截器：只传 AI_RUNNER_SANDBOX 不生效 ——
 *   拦截器没被加载时 read-only 形同虚设，且 repl-loop 每帧调用的 __AI_FLUSH_OVERLAY 从未注册
 *   （帧末 overlay flush 静默变成空操作）。此处与 /run 的 spawn 口径保持一致。
 */
export function createSession(sandbox = 'read-only'): SessionInfo {
  const sid = newSid()
  const tmpDir = path.join(getRoot(), '.ai-runner', 'tmp')
  try { fs.mkdirSync(tmpDir, { recursive: true }) } catch { /* 已存在/不可写：留给子进程报错 */ }
  const overlayPath = path.join(tmpDir, `${sid}-overlay.json`)
  const toolLogPath = path.join(tmpDir, `${sid}-tools.jsonl`)
  const handle = runReplProcess(process.execPath, {
    args: ['-r', interceptorCjsPath(), '-r', helpersCjsPath(), replLoopPath()],
    cwd: getRoot(),
    env: {
      ...process.env,
      AI_RUNNER_SANDBOX: sandbox,
      AI_RUNNER_OVERLAY: overlayPath,
      AI_RUNNER_TOOL_LOG: toolLogPath,
    },
  })
  const now = Date.now()
  const entry: SessionEntry = { handle, sandbox, createdAt: now, lastActiveAt: now, overlayPath, toolLogPath, degraded: false }
  // [repl-degraded-v1] 子进程退出即标记 degraded（不从表中删，调用方须能凭 sid 拿到 REPL_DEAD）
  handle.onExit(() => { entry.degraded = true })
  sessions.set(sid, entry)
  return { sid, sandbox, pid: handle.pid, createdAt: now, overlay: overlayPath, toolLog: toolLogPath }
}

/** [repl-degraded-v1] 查询会话是否已降级（子进程死掉）。表里没有或未死返回 false。 */
export function isSessionDegraded(sid: string): boolean {
  const e = sessions.get(sid)
  return e ? e.degraded : false
}

/** 按 sid 取会话；不存在返回 null。 */
export function getSession(sid: string): SessionEntry | null {
  return sessions.get(sid) || null
}

/** [repl-idle-reclaim-v1] 每帧刷新会话活跃时间，避免空闲回收误杀正在跑的会话。 */
export function touchSession(sid: string): void {
  const e = sessions.get(sid)
  if (e) e.lastActiveAt = Date.now()
}

/**
 * [repl-idle-reclaim-v1] 回收所有超阈值空闲的会话（含 degraded 的）。
 * [WHY] degraded 会话进程已死但 entry 仍在，若无回收路径会永久残留 overlay/toolLog。
 * [CONSTRAINT] 走 closeSession 以连带 unlink overlay/toolLog；返回被回收的 sid 列表便于测试断言。
 */
// [repl-idle-reclaim-single-trigger-v1] 唯一触发点是 POST /session；无定时器 ⇒ 无人建新会话即永不回收。
// [WHY] A 侧 ROUND 11 P2-2 实证：单会话场景下会话残留不会被清（我的 sess-mutnmuf1-1 即物证）。
// 若未来需要定时回收，另开任务并同步更新本条注释，不要让下一个人以为有后台任务。
export async function reclaimIdleSessions(now = Date.now()): Promise<string[]> {
  const stale: string[] = []
  for (const [sid, e] of sessions) {
    if (now - e.lastActiveAt > IDLE_MAX_MS) stale.push(sid)
  }
  for (const sid of stale) await closeSession(sid)
  return stale
}
export async function closeSession(sid: string): Promise<boolean> {
  const e = sessions.get(sid)
  if (!e) return false
  sessions.delete(sid)
  await e.handle.close(2000)
  try { fs.unlinkSync(e.overlayPath) } catch { /* 未产生写入即无该文件 */ }
  try { fs.unlinkSync(e.toolLogPath) } catch { /* 同上 */ }
  return true
}
