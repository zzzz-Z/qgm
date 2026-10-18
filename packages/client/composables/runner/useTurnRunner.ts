// [turn-runner-v1] 执行器的接线层：把 turn-runner.ts 的纯逻辑接到 useRunner 的真实执行通道。
//
// [R9] 真实并发 = 1，不是契约 §2.2 的 3 —— 这是当前架构的硬限制，不是懒。
// [WHY] useRunner.run 是**单飞**的：
//   ① `if (running.value)` 守卫 + 模块级单例 `abortController` ⇒ 第二个 run 会 abort 第一个；
//   ② `result` / `changes` / `liveStdout` / `liveStderr` 全是模块级单例 ⇒ 并发时互相覆盖，
//      回灌文本只能看到最后一块的结果（其余静默丢失，且完全不可观测）。
//   要开并发 3 必须先把 useRunner 改造成 N 个通道（每通道独立 abort + 独立结果槽），
//   那是独立一片工程，不能在这里顺手做。执行器本身**已支持**并发（turn-runner 单测覆盖上限 3），
//   故后续只需把这里的 maxConcurrency 调上去 + useRunner 多通道化，逻辑无需重写。
// [CONSTRAINT] autoFeedback 必须 false：否则每块执行完立刻逐条回传，N 块 = N 次提问，
//   正是 [auto-feedback-merge-v1] 花一整轮治的病；turn 口径是「1 turn = 1 轮，一次 fill」。
// [CONSTRAINT] 不用 queueIfBusy：排队意味着「稍后再跑」，而 turn 口径要求「本 turn 内跑完再回灌」；
//   并发控制权归 turn-runner 的信号量，run-queue 不得再插一层。
import { ref } from 'vue'
import { useRunner } from './useRunner'
import { createTurnRunner, formatTurnResults, pickScriptBlocks } from './turn-runner'
import type { TurnRunner, TurnRunOutcome, TurnRunResult, TurnScriptBlock } from './turn-runner'

/** 本 turn 是否还有块在跑（UI 显示「执行中」用；跨 useTurnRunner 调用共享） */
const turnRunning = ref(false)
/** 正在执行的 turn id（多 turn 交错时只显示最新的） */
const activeTurnId = ref(0)

/**
 * 单例执行器。
 * [CONSTRAINT] 必须是模块单例：幂等账本跨组件实例共享才有意义
 *   （ScriptPanel 与 auto-loop 各自调 useTurnRunner() 不能拿到两本账）。
 */
let runner: TurnRunner | null = null
let fillSink: ((text: string) => void | Promise<void>) | null = null
/**
 * 已回灌过的 turn。
 * [WHY] `runner.submit` 对同一 turn 幂等（返回旧结果），若在这里无条件再 fill 一次，
 *   同 turn 的二次进入（重放帧 / 组件重挂）就会把同一批结果**再提问一次** —— 与「1 turn = 1 轮」直接冲突。
 */
const filledTurns = new Set<number>()
const FILLED_MAX = 100

function ensureRunner(): TurnRunner {
  if (runner) return runner
  const { run, stop } = useRunner()
  runner = createTurnRunner({
    // [R9] 1：useRunner 单飞。执行器支持更高值，改造完 useRunner 多通道后改这里即可。
    maxConcurrency: 1,
    async run({ block, runKey }): Promise<TurnRunResult> {
      const r = await run({ script: block.code, runKey, autoFeedback: false })
      if (r === null) return { status: 'error', err: 'runner returned null（守卫吞掉了本轮，无 detail）' }
      if (r === 'skipped') return { status: 'skipped' }
      if (r === 'queued') return { status: 'skipped' } // 不应发生（未用 queueIfBusy）
      return { status: r.ok ? 'ok' : 'error', exit: r.code, out: r.stdout, err: r.stderr || r.error }
    },
    abort: stop,
    onOutcome(turnId) {
      activeTurnId.value = turnId
    },
  })
  return runner
}

/** 注册回灌通道（P2-b 之后由收块器传入 copyAndFill；未注册则只记账、不发送） */
export function setTurnFillSink(sink: ((text: string) => void | Promise<void>) | null): void {
  fillSink = sink
}

export interface SubmitTurnOptions {
  /** 是否在本 turn 收口后立刻回灌（缺省 true） */
  fill?: boolean
}

/**
 * 提交一个 turn 的 script 块。
 * 幂等：同 turn 二次进入复用同一 promise（重放帧 / 重连 / 组件重挂都不会重跑）。
 */
export async function submitTurn(
  turnId: number,
  blocks: unknown,
  opts: SubmitTurnOptions = {},
): Promise<TurnRunOutcome[]> {
  const list: TurnScriptBlock[] = pickScriptBlocks(blocks)
  // 无 script 块 ⇒ 本 turn 是总结轮（§2.1「无任何执行块 ⇒ 本 turn 即总结」），不执行也不回灌
  if (!list.length) return []
  turnRunning.value = true
  activeTurnId.value = turnId
  try {
    const results = await ensureRunner().submit(turnId, list)
    const text = formatTurnResults(turnId, results)
    if (opts.fill !== false && text && fillSink && !filledTurns.has(turnId)) {
      filledTurns.add(turnId)
      if (filledTurns.size > FILLED_MAX) {
        const oldest = filledTurns.values().next().value
        if (typeof oldest === 'number') filledTurns.delete(oldest)
      }
      try {
        await fillSink(text)
      }
      catch {
        // 回灌失败不影响执行结果：结果已在账本与时间线里，重试会由下一轮纠偏
      }
    }
    return results
  }
  finally {
    // 只有「本 turn 就是当前在跑的那个」才改状态，避免旧 turn 收口把新 turn 的「执行中」抹掉
    if (activeTurnId.value === turnId) turnRunning.value = ensureRunner().activeTurns().length > 0
  }
}

/** 批量取消某 turn 的在飞块（幂等；取消后无残留 run） */
export function abortTurn(turnId: number): string[] {
  const ids = ensureRunner().abortTurn(turnId, 'aborted')
  if (activeTurnId.value === turnId) turnRunning.value = false
  return ids
}

/** 取消全部在飞 turn（用户点「停止」时调用） */
export function abortAllTurns(): void {
  ensureRunner().abortAll()
  turnRunning.value = false
}

/** 预填账本：把服务端 turns.jsonl 的已执行集合灌进来（跨刷新的唯一防线） */
export function seedTurnLedger(turnId: number, outcomes: TurnRunOutcome[]): number {
  return ensureRunner().seed(turnId, outcomes)
}

/** 只读视图（调试 / 面板展示用） */
export function turnRunnerView(): {
  running: boolean
  activeTurnId: number
  activeTurns: number[]
  stats: ReturnType<TurnRunner['stats']>
  outcomesOf: (turnId: number) => TurnRunOutcome[]
} {
  const r = ensureRunner()
  return {
    running: turnRunning.value,
    activeTurnId: activeTurnId.value,
    activeTurns: r.activeTurns(),
    stats: r.stats(),
    outcomesOf: (t: number) => r.outcomesOf(t),
  }
}

/** 重置（会话切换 / 测试用） */
export function resetTurnRunner(): void {
  runner?.reset()
  runner = null
  filledTurns.clear()
  activeTurnId.value = 0
  turnRunning.value = false
}

/** 组合式入口（与项目其余 composable 同形；状态是模块单例） */
export function useTurnRunner() {
  return {
    turnRunning,
    activeTurnId,
    submitTurn,
    abortTurn,
    abortAllTurns,
    seedTurnLedger,
    setTurnFillSink,
    view: turnRunnerView,
    reset: resetTurnRunner,
  }
}
