// [subagent-orchestrator-v1] 子智能体编排：任务契约 + 可插拔执行体 + 并发槽。
//
// [WHY] 子智能体的难点不在「起子进程」（session-manager 早已提供），而在编排：
//   谁拆任务、派给谁、怎么收结果、失败怎么办、并发如何控。本文件只做编排，
//   执行体是可插拔策略 —— 当前实现 repl-script（复用现有会话能力），
//   宿主侧后续可注入 llm 执行体而不改本文件一行。
//
// [CONSTRAINT] 本文件**不得**直接调 LLM：LLM 是宿主侧依赖，编排层只定义契约。
//   这条边界保证编排层可在纯 Node 环境完整测试。

/** 任务状态机：pending → running → done/failed；任意非终态可 → cancelled。 */
import { createSlotQueue } from '../headless/headless-slot-queue.js'

export type SubagentStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

/** 执行体类型标识。新增执行体时在此登记。 */
export type ExecutorKind = 'repl-script'

/** 子任务描述。 */
export interface SubagentTask {
  id: string
  description: string
  executor: ExecutorKind
  status: SubagentStatus
  /** 执行体返回的结构化结果（仅在 done 时有值） */
  result?: SubagentResult
  /** 失败原因（仅在 failed 时有值） */
  error?: string
  /** 关联的会话 id（repl-script 执行体创建） */
  sessionId?: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
}

/** 子任务结果协议：强制只回摘要与产物指针，不回原始日志（防主上下文被撑爆）。 */
export interface SubagentResult {
  summary: string
  artifacts: string[]
  /** 执行体自定义的附加字段（如 frame 的原始返回摘要） */
  meta?: Record<string, unknown>
}

/** 执行体策略接口：编排器只依赖此契约，不关心内部如何执行。 */
export interface TaskExecutor {
  readonly kind: ExecutorKind
  /**
   * 执行任务。
   * @param task 任务描述（只读）
   * @param signal 取消信号（编排器在 cancel 时 abort）
   * @returns 结构化结果
   */
  run: (task: SubagentTask, signal: AbortSignal) => Promise<SubagentResult>
  /** 任务取消/失败时的清理（关闭会话等），失败不抛。 */
  cleanup?: (task: SubagentTask) => Promise<void>
}

/** 编排器配置。 */
export interface OrchestratorOptions {
  /** 并发上限，缺省 3 */
  maxConcurrent?: number
  /** 排队超时（ms），缺省 30s；超时后仍会执行，只是不再等槽 */
  queueTimeoutMs?: number
  /** 单个任务整体超时（ms），缺省 10 分钟；超时 abort 执行体并标 failed */
  taskTimeoutMs?: number
}

let _seq = 0
function newTaskId(): string {
  _seq += 1
  return `sub-${Date.now().toString(36)}-${_seq.toString(36)}`
}

/** 创建编排器实例。每个实例持有独立任务表与并发槽（便于测试隔离）。 */
export function createSubagentOrchestrator(executors: TaskExecutor[], opts: OrchestratorOptions = {}) {
  const maxConcurrent = Math.max(1, opts.maxConcurrent ?? 3)
  const queueTimeoutMs = Math.max(1000, opts.queueTimeoutMs ?? 30000)
  const taskTimeoutMs = Math.max(1000, opts.taskTimeoutMs ?? 600000)
  const tasks = new Map<string, SubagentTask>()
  const controllers = new Map<string, AbortController>()
  const execMap = new Map<ExecutorKind, TaskExecutor>()
  for (const e of executors) execMap.set(e.kind, e)
  const slot = createSlotQueue(maxConcurrent, queueTimeoutMs)
  let running = 0

  /** 取执行体；未注册返回 undefined。 */
  function executorOf(kind: ExecutorKind): TaskExecutor | undefined {
    return execMap.get(kind)
  }

  /** 核心执行流程：取槽 → 标记 running → 跑 → 记结果 → 释放槽。 */
  async function _run(task: SubagentTask): Promise<void> {
    const ex = executorOf(task.executor)
    if (!ex) {
      task.status = 'failed'
      task.error = `unknown executor: ${task.executor}`
      task.finishedAt = Date.now()
      return
    }
    if (slot.isFull(running)) await slot.acquire()
    running += 1
    const ctrl = new AbortController()
    // [subagent-task-timeout-v1] 区分「超时触发 abort」与「用户取消」：两者都走 abort，但终态不同。
    let timedOut = false
    controllers.set(task.id, ctrl)
    task.status = 'running'
    task.startedAt = Date.now()
    try {
      // [subagent-task-timeout-v1] 整体超时与执行竞速：超时 abort 执行体并标 failed。
      // [WHY] 执行体若不响应 abort（如卡在不支持中断的 await），任务会永久挂起；
      //   编排层必须有兜底，否则看板永远停在 running。
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeoutGuard = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          ctrl.abort()
          reject(new Error(`task timeout after ${taskTimeoutMs}ms`))
        }, taskTimeoutMs)
      })
      let result: SubagentResult
      try {
        result = await Promise.race([ex.run(task, ctrl.signal), timeoutGuard])
      } finally {
        if (timer) clearTimeout(timer)
      }
      if (ctrl.signal.aborted) {
        task.status = 'cancelled'
      } else {
        task.status = 'done'
        task.result = result
      }
    } catch (e) {
      task.status = timedOut ? 'failed' : (ctrl.signal.aborted ? 'cancelled' : 'failed')
      if (!ctrl.signal.aborted || timedOut) task.error = String((e as { message?: string })?.message || e)
    } finally {
      task.finishedAt = Date.now()
      controllers.delete(task.id)
      running -= 1
      slot.release()
      // 终态清理：关闭会话等；清理失败不改变任务状态
      if (ex.cleanup) { try { await ex.cleanup(task) } catch { /* 清理失败不影响结果 */ } }
    }
  }

  return {
    /**
     * 提交子任务（立即返回 taskId，异步执行）。
     * @param req 任务描述与执行体类型
     * @returns 已登记的任务（status=pending）
     */
    submit(req: { description: string, executor?: ExecutorKind }): SubagentTask {
      const task: SubagentTask = {
        id: newTaskId(),
        description: String(req.description || ''),
        executor: req.executor || 'repl-script',
        status: 'pending',
        createdAt: Date.now(),
      }
      tasks.set(task.id, task)
      // 不 await：提交即返回。用 queueMicrotask 推迟一帧，保证调用方拿到的快照是 pending
      // （直接 void _run 会同步进入 running，返回态不稳定，调用方无法区分「已接受」与「已开跑」）。
      queueMicrotask(() => { void _run(task) })
      return task
    },

    /** 按 id 取任务快照。 */
    get(id: string): SubagentTask | null {
      const t = tasks.get(id)
      return t ? { ...t } : null
    },

    /** 列出全部任务快照（可按状态过滤）。 */
    list(status?: SubagentStatus): SubagentTask[] {
      const all = [...tasks.values()].map(t => ({ ...t }))
      return status ? all.filter(t => t.status === status) : all
    },

    /** 取消任务：abort 执行体；已在终态则无操作。 */
    cancel(id: string): boolean {
      const t = tasks.get(id)
      if (!t || t.status === 'done' || t.status === 'failed' || t.status === 'cancelled') return false
      const ctrl = controllers.get(id)
      if (ctrl) ctrl.abort()
      t.status = 'cancelled'
      t.finishedAt = Date.now()
      return true
    },

    /** 汇总计数。 */
    summary() {
      const s: Record<SubagentStatus, number> = { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 }
      for (const t of tasks.values()) s[t.status] += 1
      return { total: tasks.size, ...s, maxConcurrent, runningNow: running }
    },
  }
}

/** 编排器实例类型（供路由与测试使用）。 */
export type SubagentOrchestrator = ReturnType<typeof createSubagentOrchestrator>
