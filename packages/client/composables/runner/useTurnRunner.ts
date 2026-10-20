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
// [runtime-kind-ssot-v1] 运行态单一真相源：执行器是本项目「脚本阶段」的唯一写入方
import { useRuntime } from '../ai/useRuntime'
// [script-head-autofill-v1] 信封 desc/why 是 JSON 字段，/run 的头契约要求它们出现在 code 首部
//   （scanScriptHead 缺则 MISSING_DESC 400）——在接线层用信封字段补齐，避免 AI 两头都写。
import { ensureScriptHead } from '../../utils/scriptMeta'
// [board-mirror-turn-v1] turn 回灌附看板块（显式 import：vitest 无 auto-import 插件）
import { fetchBoardMirror } from '../ai/board-mirror'

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

/** 投递结果（与 copyAndFill 的 FillResult 同形；此处内联定义以免跨模块 type import） */
export type TurnFillResult = 'sent' | 'opened' | 'failed' | 'unacked'
/** 回灌上下文：sink 在等待窗口之后用它自证「这一轮仍值得发」 */
export interface TurnFillCtx {
  turnId: number
  /** 会话纪元未变 且 该 turn 未被取消 ⇒ true */
  stillValid: () => boolean
}
export type TurnFillSink = (text: string, ctx: TurnFillCtx) => void | TurnFillResult | Promise<void | TurnFillResult>
let fillSink: TurnFillSink | null = null
/**
 * 已回灌过的 turn。
 * [WHY] `runner.submit` 对同一 turn 幂等（返回旧结果），若在这里无条件再 fill 一次，
 *   同 turn 的二次进入（重放帧 / 组件重挂）就会把同一批结果**再提问一次** —— 与「1 turn = 1 轮」直接冲突。
 */
const filledTurns = new Set<number>()
const FILLED_MAX = 100

/**
 * [turn-feedback-delay-v1] 脚本全部跑完 → 回传之间的强制静默（ms）。
 * [WHY] turn 主路径此前是 0 延迟：AI 回复 → 跑脚本 → 立刻回传 → AI 再回复……连续轮次的出站间隔
 *   只受脚本执行时长支配，短脚本场景会把出站频率打到平台限流（用户实测「发送频率太快」）。
 * [CONSTRAINT] 与旧 ScriptPanel 合并窗（AUTO_FEEDBACK_MERGE_MS=3000）同量级但语义不同：
 *   这里不合并多条（1 turn = 1 条回传），只是**延迟出站**，故不复用合并窗实现。
 * [CONSTRAINT] 只在回灌通道（useAppStartup 的 sink）消费，不放进 submitTurn：
 *   放进 submitTurn 会让所有接线单测凭空多等 3s（且单测注入的是各自的 sink，本就绕过生产通道）。
 */
export const TURN_FEEDBACK_DELAY_MS = 3000

/**
 * [turn-feedback-epoch-v1] 会话纪元：切工作区 / 切会话时自增。
 * [WHY] 3 秒静默窗是**异步悬挂**的：等待期间切 root，窗口结束时会无条件把旧会话的结果
 *   投进新会话的窗口（用户实测切工作区后回传串到别处）。
 */
let turnEpoch = 0

/** 已取消的 turn；取消后其回灌不得再发出（「停止」后仍回传 = 用户以为已经停了） */
const abortedTurns = new Set<number>()
const ABORTED_MAX = 100

/**
 * [turn-fill-serial-v1] 回灌串行闸门：两轮结果同时到点时必须排队写同一输入框。
 * [WHY] copyAndFill 侧无互斥，两路并行会互相覆盖或双发；而两轮 sink 的到达时刻只差脚本耗时，
 *   短脚本场景必然重叠。
 * [CONSTRAINT] 前一个失败也要继续下一个（`then(task, task)`），否则一次投递异常会卡死后续所有回灌。
 */
let fillQueue: Promise<unknown> = Promise.resolve()

function enqueueFill(task: () => Promise<unknown> | unknown): Promise<unknown> {
  const next = fillQueue.then(task, task)
  fillQueue = next.then(() => undefined, () => undefined)
  return next
}

function markAborted(turnId: number): void {
  abortedTurns.add(turnId)
  if (abortedTurns.size > ABORTED_MAX) {
    const oldest = abortedTurns.values().next().value
    if (typeof oldest === 'number') abortedTurns.delete(oldest)
  }
}

function ensureRunner(): TurnRunner {
  if (runner) return runner
  const { run, stop } = useRunner()
  runner = createTurnRunner({
    // [R9] 1：useRunner 单飞。执行器支持更高值，改造完 useRunner 多通道后改这里即可。
    maxConcurrency: 1,
    async run({ block, runKey }): Promise<TurnRunResult> {
      const r = await run({ script: ensureScriptHead(block.code, block.desc, block.why), runKey, autoFeedback: false, turnDriven: true })
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

/** 注册回灌通道（由收块器传入 copyAndFill；未注册则只记账、不发送） */
export function setTurnFillSink(sink: TurnFillSink | null): void {
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
  // [runtime-kind-ssot-v1] 开始跑脚本 ⇒ 运行态 executing（等待 banner 隐藏、看板显示「执行中」）
  const rt = useRuntime()
  rt.enterExecuting()
  turnRunning.value = true
  activeTurnId.value = turnId
  try {
    const results = await ensureRunner().submit(turnId, list)
    const text = formatTurnResults(turnId, results)
    // [board-mirror-turn-v1] turn 回灌末尾附看板块（未完成清单 / 空板登记提醒）。
    // [WHY] board-mirror 原只接在旧面板回传（script-panel-actions.buildAiPrompt）上，turn 管线
    //   这一主链路此前零注入——AI 每轮看不到看板，是「任务状态不同步」的架构性缺口
    //   （2026-10-20 实证：说了提示词 AI 才调 tasks API，不说就 4 小时 161 脚本 0 写入）。
    // [CONSTRAINT] 抓取失败/网络异常 ⇒ 原样回灌 text，绝不阻断结果通道（与旧路径同纪律）；
    //   与旧路径互斥（[turn-feedback-exclusive-v1]），不会双重注入。
    let fillText = text
    try {
      const board = await fetchBoardMirror(undefined, { remindRegister: true })
      if (text && board) fillText = `${text}\n\n${board}`
    } catch { /* 看板不可用不影响结果回传 */ }
    // [CONSTRAINT] 取成局部 const：条件里 `!!fillSink` 的窄化不会留到后面，
    //   直接引用模块级 fillSink 会被 TS 判为「可能为 null」（且它在等待窗内可能被置空）。
    const sink = fillSink
    if (opts.fill !== false && text && sink && !filledTurns.has(turnId)) {
      // [runtime-kind-ssot-v1] 脚本跑完、结果待出站（含 3s 静默窗）⇒ feedback
      rt.enterFeedback()
      filledTurns.add(turnId)
      if (filledTurns.size > FILLED_MAX) {
        const oldest = filledTurns.values().next().value
        if (typeof oldest === 'number') filledTurns.delete(oldest)
      }
      const epochAtSubmit = turnEpoch
      const ctx: TurnFillCtx = {
        turnId,
        stillValid: () => turnEpoch === epochAtSubmit && !abortedTurns.has(turnId),
      }
      // [turn-feedback-result-v1] 投递结果必须回流：只 try/catch 吞掉的话，`failed` 会让这一轮结果
      //   永久丢失且界面无提示（filledTurns 已置位 ⇒ 之后再也不重发）。故失败即回滚去重位。
      try {
        const r = await enqueueFill(() => sink(fillText, ctx))
        if (r === 'failed' || r === 'unacked') filledTurns.delete(turnId)
      }
      catch {
        filledTurns.delete(turnId)
      }
      // [runtime-kind-ssot-v1] 回传已出站 ⇒ 回到「等待下一轮回复」。
      // [CONSTRAINT] 仅当仍处于本 turn 的 executing / feedback：静默窗内用户已停（stopped）时不得覆写。
      const k = rt.state.value.kind
      if (k === 'executing' || k === 'feedback') rt.enterWaiting()
    }
    else {
      // [runtime-kind-ssot-v1] 无待发内容（无回传通道 / 空结果 / 已回传过）⇒ 收口回 idle
      rt.settleIdle()
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
  markAborted(turnId)
  if (activeTurnId.value === turnId) turnRunning.value = false
  return ids
}

/** 取消全部在飞 turn（用户点「停止」时调用） */
export function abortAllTurns(): void {
  // [turn-feedback-epoch-v1] 先记账后取消：取消后这些 turn 的回灌会被 stillValid() 挡住
  for (const t of ensureRunner().activeTurns()) markAborted(t)
  ensureRunner().abortAll()
  turnRunning.value = false
  // [runtime-kind-ssot-v1] 取消全部在飞 turn = 用户停止 ⇒ 运行态 stopped（不再自己变回 idle）
  useRuntime().stop()
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

/** 重置（会话 / 工作区切换；测试亦用） */
export function resetTurnRunner(): void {
  runner?.reset()
  runner = null
  filledTurns.clear()
  abortedTurns.clear()
  // [turn-feedback-epoch-v1] 自增纪元：让此刻悬挂在 3 秒窗里的回灌失效，不得投进新会话
  turnEpoch++
  activeTurnId.value = 0
  turnRunning.value = false
  // [runtime-kind-ssot-v1] 切 root / 切会话时运行态必须归零：否则 sessionStorage 里恢复的 stale kind
  //   会继续误导 UI（等待 banner 卡在旧工作区）。
  useRuntime().reset()
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
