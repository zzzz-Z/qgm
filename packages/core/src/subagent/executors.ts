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
    // [subagent-script-wrap-v1] REPL 帧丢弃 vm 返回值（repl-loop.cjs: vm.runInThisContext 结果未回传），
    // 脚本产出只能经 __AI__.ok 进 logs 再随帧回传。故统一包装：执行描述后把结果 JSON 打印出来。
    const raw = String(task.description || '')
    // [subagent-sync-wrap-v1] 同步包装：repl-loop 的 emit 在 vm.runInThisContext 返回后立即触发，
    //   异步 .then 的回调来不及进 logs（实测 logs=undefined）。故脚本必须同步产出结果。
    // [CONSTRAINT] 需要异步能力的任务应改用未来宿主侧接入的 llm 执行体，而非本执行体。
    const body = /^\s*(?:;\s*)?\(\s*\)\s*=>/.test(raw) || /^\s*(?:;\s*)?\(async\s*\(\)\s*=>/.test(raw)
      ? raw
      : `(() => {\n${raw}\n})()`
    const code = `;(() => { const __r = (${body}); __AI__.ok(JSON.stringify({ __subagent: true, result: __r === undefined ? null : __r })); })()`
    entry.handle.send({ id: task.id, code })
    const frame = await entry.handle.nextFrame(120000) as { ok?: boolean, error?: string, logs?: string[] }
    if (frame && frame.ok === false) throw new Error(String(frame.error || 'frame failed'))
    const logs = (frame.logs || []).map(l => String(l))
    // [subagent-logs-parse-v1] __AI__.ok 输出带 ANSI 颜色前缀（\u001b[32m✓\u001b[39m ），
    // 解析时须找第一个 '{' 起截，不能假设 logs 以 JSON 开头（实测踩过）。
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
