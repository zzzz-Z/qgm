// [subagent-executors-v1] 内置执行体实现。
//
// [WHY] 编排器只依赖 TaskExecutor 契约；本文件提供当前可用的唯一实现
//   repl-script（复用 session-manager 的隔离会话）。宿主侧后续接入 LLM 执行体时，
//   只需实现同一契约并注入 createSubagentOrchestrator，编排逻辑零改动。
//
// [CONSTRAINT] 结果协议强制：只回 summary（≤500 字符）+ artifacts 指针，
//   绝不回传子会话完整输出 —— 这是子智能体不撑爆主上下文的根本保证。
import { closeSession, createSession, getSession } from '../process/session-manager.js'
import type { SubagentResult, SubagentTask, TaskExecutor } from './orchestrator.js'

/** summary 截断上限：超出即视为「回传原始日志」的违规，强制收缩。 */
const SUMMARY_MAX = 500

/** 从任意执行体返回中提取结构化摘要。 */
function toResult(raw: unknown): SubagentResult {
  const obj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const text = typeof obj.summary === 'string' ? obj.summary : (typeof raw === 'string' ? raw : JSON.stringify(raw ?? null))
  const summary = text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX)}…[truncated]` : text
  const artifacts = Array.isArray(obj.artifacts) ? obj.artifacts.filter((x): x is string => typeof x === 'string') : []
  return { summary, artifacts, meta: obj }
}

/**
 * repl-script 执行体：在隔离会话里跑一段脚本，只回摘要。
 * 任务描述按约定格式提供脚本（description 即脚本源码）；非脚本类描述会被原样作为 JS 执行。
 */
export const replScriptExecutor: TaskExecutor = {
  kind: 'repl-script',
  async run(task: SubagentTask, signal: AbortSignal): Promise<SubagentResult> {
    if (signal.aborted) throw new Error('aborted before start')
    const info = createSession('workspace-write')
    task.sessionId = info.sid
    const entry = getSession(info.sid)
    if (!entry) throw new Error('session create failed')
    if (signal.aborted) {
      await closeSession(info.sid).catch(() => false)
      throw new Error('aborted after create')
    }
    // [subagent-async-wrap-v1] 无条件包 async IIFE（repl-loop 已支持 await Promise 后再 emit）。
    // [WHY] 不做「已包装则跳过」判断：raw 的 `;(async` 前缀与 await 括号会拼成非法语法（实测多次）。
    // [CONSTRAINT] 结果经 __AI__.ok 输出——REPL 丢弃 vm 返回值，logs 是唯一回传通道。
    const raw = String(task.description || '')
    const body = `(async () => {
${raw}
})()`
    const code = `;(async () => { const __r = await (${body}); __AI__.ok(JSON.stringify({ __subagent: true, result: __r === undefined ? null : __r })); })().catch(e => __AI__.err(String(e && e.message ? e.message : e)))`
    entry.handle.send({ id: task.id, code })
    // [subagent-frame-timeout-v1] 帧等待与 abort 竞速：取消立即生效，不必等满 nextFrame 超时。
    // [WHY] 原先只有 nextFrame(120000) 硬编码兜底，cancel 后仍要等满 120s 才退出（实测缺陷）。
    // [CONSTRAINT] abort 只影响等待，不杀会话——清理仍走 cleanup 关闭会话。
    const FRAME_TIMEOUT_MS = Number(process.env.AI_RUNNER_SUBAGENT_FRAME_TIMEOUT_MS) || 120000
    const frame = await Promise.race([
      entry.handle.nextFrame(FRAME_TIMEOUT_MS),
      new Promise<never>((_, reject) => {
        if (signal.aborted) { reject(new Error('aborted while waiting frame')); return }
        const onAbort = () => { reject(new Error('aborted while waiting frame')) }
        signal.addEventListener('abort', onAbort, { once: true })
      }),
    ]) as { ok?: boolean, error?: string, logs?: string[] }
    if (frame && frame.ok === false) throw new Error(String(frame.error || 'frame failed'))
    const logs = (frame.logs || []).map(l => String(l))
    // [subagent-logs-parse-v1] __AI__.ok 输出带 ANSI 前缀，从第一个 '{ ' 起截再 JSON.parse。
    const tag = logs.find(l => l.includes('"__subagent":true'))
    if (!tag) return { summary: '(no __subagent output)', artifacts: [], meta: { logs: logs.slice(-3) } }
    const braceAt = tag.indexOf('{')
    const jsonText = braceAt >= 0 ? tag.slice(braceAt) : tag
    let parsed: unknown = null
    try { parsed = JSON.parse(jsonText) } catch { parsed = null }
    const inner = (parsed && typeof parsed === 'object' && 'result' in (parsed as Record<string, unknown>))
      ? (parsed as Record<string, unknown>).result
      : parsed
    return toResult(inner)
  },
  async cleanup(task: SubagentTask): Promise<void> {
    if (task.sessionId) await closeSession(task.sessionId).catch(() => false)
  },
}

/** 默认执行体集合。宿主侧接入 LLM 执行体后追加到此数组即可。 */
export const defaultExecutors: TaskExecutor[] = [replScriptExecutor]
