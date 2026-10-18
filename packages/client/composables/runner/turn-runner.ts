// [turn-runner-v1] turn 信封执行器核心（纯逻辑：零 vue 依赖、零项目 composables 依赖）
//
// [WHY] 信封把一个 turn 的 N 个 script 块一次性交出来。沿用旧的「逐脚本 run + run-queue 排队」
//   有三个硬问题：
//   ① 记账口径错：N 个脚本 = N 轮，而契约 §2.2 明写「1 turn = 1 轮」；
//   ② 无去重口径：重放帧（ai:block 的 replay）/ 页面重连 / 同一 turn 二次进入会把同一批
//      脚本再跑一遍 —— 侧效应不可撤销（写文件、起进程、发请求）；
//   ③ 顺序失控：脚本卡由 `run:start` 建立，卡的先后 = 启动先后。若并发窗口内乱序启动，
//      UI 顺序会随网络抖动（R8），而用户看到的是「执行顺序和我写的不同」。
//
// [CONSTRAINT] 并发上限默认 3（契约 §2.2），但**启动顺序必须严格按 `seq`**：
//   按 seq 排序后顺序 launch（同步调用 deps.run 取 promise，不 await），仅当槽位用尽才等释放。
//   这样「启动序 = seq 序」，而「执行期 = 并行」。
// [CONSTRAINT] 幂等账本键为 `turn|id`，一旦记账**永不覆盖**：重复进入 / aborted / superseded
//   都不重跑。账本只认 script 块的显式 id（R7：say 的自动 id 会随下标漂移，不参与执行记账）。
// [CONSTRAINT] 本模块零依赖（不 import vue / 项目模块）——vitest 可裸跑真实驱动，
//   与 run-queue.ts / feedback-merge.ts 同纪律。

/** 执行结局 */
export type TurnRunStatus = 'ok' | 'error' | 'skipped' | 'aborted' | 'superseded'

/** 送入执行器的 script 块（字段取自信封，缺省值由调用方补齐） */
export interface TurnScriptBlock {
  id: string
  /** 信封内数组下标（§seq）；启动顺序的唯一依据 */
  seq: number
  code: string
  lang?: string
  desc?: string
  why?: string
}

/** 注入的 run 返回的最小结果形状（由接线层从 RunResponse 映射） */
export interface TurnRunResult {
  status: TurnRunStatus
  exit?: number
  out?: string
  err?: string
}

/** 账本内的一条记录 */
export interface TurnRunOutcome extends TurnRunResult {
  /** 块 id（`turn|id` 的后半段） */
  id: string
  /** = 块 seq；回灌与 UI 都按此排序 */
  seq: number
}

export interface TurnRunnerDeps {
  /** 真正执行一个块；`runKey` 恒为 `turn|id`，供事件聚合到一张脚本卡 */
  run: (arg: { block: TurnScriptBlock, runKey: string, turnId: number }) => Promise<TurnRunResult>
  /** 中止在飞执行（通常是 useRunner 的 stop）；取消后结果一律改写为 aborted/superseded */
  abort?: () => void
  /** 同 turn 并发上限，缺省 3 */
  maxConcurrency?: number
  /** 账本保留的 turn 数，缺省 50（超出淘汰最旧的**已完成** turn） */
  maxTurns?: number
  /** 每块落地即回调（UI 可据此增量更新） */
  onOutcome?: (turnId: number, outcome: TurnRunOutcome) => void
  /** 整个 turn 收口（含被账本命中的旧记录），results 按 seq 排序 */
  onTurnEnd?: (turnId: number, results: TurnRunOutcome[], rounds: number) => void
}

export interface TurnRunnerStats {
  /** 累计真正 launch 的块数（不含账本命中） */
  started: number
  /** 当前在飞块数 */
  inFlight: number
  /** 历史最大在飞块数（并发守卫的观测值） */
  maxInFlight: number
  /** 累计记账轮数：每个 turn 恒为 1 */
  rounds: number
}

export interface TurnRunner {
  /** 幂等提交：同 turn 二次进入复用同一 promise，返回同一份结果 */
  submit: (turnId: number, blocks: TurnScriptBlock[]) => Promise<TurnRunOutcome[]>
  /**
   * 预填账本（跨刷新 / 重放帧的唯一防线）。
   * [WHY] 页面重连后 `ai:block` / `ai:turn-end` 会带 `replay:true` 重放，此时客户端是**新实例**，
   *   turns 缓存为空 —— 只有把服务端 `turns.jsonl` 的已执行集合灌进账本，才能避免把同一批
   *   脚本再跑一遍（侧效应不可撤销）。已有记账不覆盖（首次记录更可信）。
   */
  seed: (turnId: number, outcomes: TurnRunOutcome[]) => number
  /** 批量取消该 turn 的在飞块；返回被取消的块 id（按启动序） */
  abortTurn: (turnId: number, reason?: 'aborted' | 'superseded') => string[]
  /** 取消所有在飞 turn */
  abortAll: () => void
  /** 该 turn 是否已记账（含 seed 灌入的） */
  has: (turnId: number, blockId: string) => boolean
  /** 已记账结果（按 seq 排序，只含已落地的块） */
  outcomesOf: (turnId: number) => TurnRunOutcome[]
  /** 仍有在飞块的 turn */
  activeTurns: () => number[]
  stats: () => TurnRunnerStats
  /** 清空账本与计数（仅测试 / 会话切换用） */
  reset: () => void
}

export const DEFAULT_TURN_CONCURRENCY = 3
export const DEFAULT_MAX_TURNS = 50

/** 账本键：`turn|id`（与 runKey 同形，便于一眼对应） */
export function turnRunKey(turnId: number, blockId: string): string {
  return `${turnId}|${blockId}`
}

/** 从任意块列表里挑出可执行项并按 seq 排序（幂等：不修改入参） */
export function pickScriptBlocks(blocks: unknown): TurnScriptBlock[] {
  if (!Array.isArray(blocks)) return []
  const out: TurnScriptBlock[] = []
  blocks.forEach((b, i) => {
    if (!b || typeof b !== 'object') return
    const o = b as Record<string, unknown>
    if (typeof o.id !== 'string' || o.id.length === 0) return
    if (o.type !== undefined && o.type !== 'script') return
    if (typeof o.code !== 'string' || o.code.trim().length === 0) return
    out.push({
      id: o.id,
      seq: typeof o.seq === 'number' && Number.isFinite(o.seq) ? o.seq : i,
      code: o.code,
      lang: typeof o.lang === 'string' ? o.lang : undefined,
      desc: typeof o.desc === 'string' ? o.desc : undefined,
      why: typeof o.why === 'string' ? o.why : undefined,
    })
  })
  return out.sort((a, b) => a.seq - b.seq)
}

/**
 * 回灌文案（一次 fill 覆盖一个 turn 的全部块结果）。
 * [WHY] 契约 §2.2：1 turn = 1 轮 —— 若按块逐条回传，N 个脚本会放大成 N 次提问。
 * [CONSTRAINT] 只做结构化摘要、不内联源码：源码由各块的脚本卡承载，回灌文本重复一遍
 *   会让上下文体积随块数线性膨胀。
 */
export function formatTurnResults(turnId: number, results: TurnRunOutcome[]): string {
  if (!results.length) return ''
  const okN = results.filter(r => r.status === 'ok').length
  const head = `# turn ${turnId} 执行结果（${results.length} 块 · 成功 ${okN} · 未成功 ${results.length - okN}）`
  const lines = results.map((r, i) => {
    const tag = r.status === 'ok' ? '✅' : r.status === 'skipped' ? '⏭' : '❌'
    const exit = typeof r.exit === 'number' ? ` exit=${r.exit}` : ''
    const err = r.err ? ` err=${r.err.slice(0, 200)}` : ''
    return `${i + 1}. ${tag} ${r.id} [${r.status}]${exit}${err}`
  })
  return [head, ...lines].join('\n')
}

/** 创建执行器实例 */
export function createTurnRunner(deps: TurnRunnerDeps): TurnRunner {
  const max = Math.max(1, Math.floor(deps.maxConcurrency ?? DEFAULT_TURN_CONCURRENCY))
  const maxTurns = Math.max(1, Math.floor(deps.maxTurns ?? DEFAULT_MAX_TURNS))
  /** 幂等账本：`turn|id` → 结果；一旦写入不再覆盖 */
  const ledger = new Map<string, TurnRunOutcome>()
  /** turn → 块 id 列表（按 seq），保证 outcomesOf 与回灌的确定性顺序 */
  const order = new Map<number, string[]>()
  /** turn → submit 的收口 promise（同 turn 二次进入复用，天然幂等） */
  const turns = new Map<number, Promise<TurnRunOutcome[]>>()
  /** turn → 已 launch 未落地的块 id */
  const starting = new Map<number, Set<string>>()
  /** turn → 取消标记 */
  const marks = new Map<number, 'aborted' | 'superseded'>()
  /** 已收口 turn（淘汰只挑这些，避免把在飞账本抹掉导致重跑） */
  const settled = new Set<number>()

  let inFlight = 0
  let maxInFlight = 0
  let started = 0
  let rounds = 0

  // ── 信号量：只控制「同时执行数」，不改变「启动顺序」 ──
  let avail = max
  const waiters: Array<() => void> = []
  /** 槽位转交：有等待者直接唤醒（avail 不变），否则归还 */
  function release(): void {
    const next = waiters.shift()
    if (next) next()
    else avail += 1
  }
  function acquire(): Promise<void> {
    return new Promise<void>((resolve) => { waiters.push(resolve) })
  }

  /** 淘汰最旧的已完成 turn（账本上限） */
  function trim(): void {
    if (order.size <= maxTurns) return
    for (const t of [...order.keys()]) {
      if (order.size <= maxTurns) break
      if (!settled.has(t)) continue
      const ids = order.get(t) || []
      order.delete(t)
      marks.delete(t)
      starting.delete(t)
      turns.delete(t)
      settled.delete(t)
      for (const id of ids) ledger.delete(turnRunKey(t, id))
    }
  }

  /**
   * 启动一块。**同步**调用 deps.run（不 await），保证调用方的循环顺序即启动顺序。
   * 返回的 promise 只用于「等全部落地」，其 resolve 值走账本。
   */
  function launch(turnId: number, block: TurnScriptBlock, results: Map<string, TurnRunOutcome>): Promise<void> {
    const key = turnRunKey(turnId, block.id)
    started += 1
    inFlight += 1
    if (inFlight > maxInFlight) maxInFlight = inFlight
    let pending = starting.get(turnId)
    if (!pending) {
      pending = new Set<string>()
      starting.set(turnId, pending)
    }
    pending.add(block.id)

    const promise = (async (): Promise<void> => {
      let outcome: TurnRunOutcome
      const early = marks.get(turnId)
      if (early) {
        // 已取消：不再真的执行，直接记账（避免「停止后仍在起进程」）
        outcome = { id: block.id, seq: block.seq, status: early }
      }
      else {
        try {
          const r = await deps.run({ block, runKey: key, turnId })
          outcome = { id: block.id, seq: block.seq, ...r }
        }
        catch (e) {
          outcome = { id: block.id, seq: block.seq, status: 'error', err: e instanceof Error ? e.message : String(e) }
        }
        // 取消窗口内落地的结果不采信：用户已点停止，这一轮产物无法解释成败
        const mark = marks.get(turnId)
        if (mark) outcome = { id: outcome.id, seq: outcome.seq, status: mark, exit: outcome.exit }
      }
      ledger.set(key, outcome)
      results.set(block.id, outcome)
      starting.get(turnId)?.delete(block.id)
      inFlight -= 1
      try {
        deps.onOutcome?.(turnId, outcome)
      }
      catch { /* 观察者异常不挡主链路 */ }
    })().finally(() => { release() })

    return promise
  }

  function abortTurn(turnId: number, reason: 'aborted' | 'superseded' = 'aborted'): string[] {
    const pending = starting.get(turnId)
    const ids = pending ? [...pending] : []
    const live = ids.length > 0
    // 仍在等槽位（已 submit 未收口、尚无在飞块）也要能取消：mark 会让后续 launch 直接短路
    const open = turns.has(turnId) && !settled.has(turnId)
    if (!live && !open) return []
    marks.set(turnId, reason)
    // [CONSTRAINT] 只在本 turn 真有在飞块时才调 abort：`abort` 是**全局** stop，
    //   对已收口 / 仅排队的 turn 调用会把别的 turn 正在跑的执行一起掐掉（R9 单飞放大）。
    if (live) {
      try {
        deps.abort?.()
      }
      catch { /* 中止通道异常不该挡住记账 */ }
    }
    return ids
  }

  function submit(turnId: number, blocks: TurnScriptBlock[]): Promise<TurnRunOutcome[]> {
    const prev = turns.get(turnId)
    if (prev) return prev
    const list = Array.isArray(blocks)
      ? blocks
          .filter(b => !!b && typeof b.id === 'string' && b.id.length > 0 && typeof b.code === 'string' && b.code.trim().length > 0)
          .map((b, i) => ({ ...b, seq: typeof b.seq === 'number' && Number.isFinite(b.seq) ? b.seq : i }))
          .sort((a, b) => a.seq - b.seq)
      : []
    // 空列表不记账：否则同 turn 后续真正的块会被上面的幂等闸门挡掉
    if (!list.length) return Promise.resolve<TurnRunOutcome[]>([])

    // 新 turn 到来 ⇒ 在飞的旧 turn 被取代（预算口径：只有最新 turn 有效）
    for (const t of [...starting.keys()]) {
      if (t < turnId && (starting.get(t)?.size ?? 0) > 0) abortTurn(t, 'superseded')
    }

    rounds += 1
    order.set(turnId, list.map(b => b.id))
    const results = new Map<string, TurnRunOutcome>()
    const todo: TurnScriptBlock[] = []
    for (const b of list) {
      const hit = ledger.get(turnRunKey(turnId, b.id))
      if (hit) results.set(b.id, hit)
      else todo.push(b)
    }

    const done = (async (): Promise<TurnRunOutcome[]> => {
      const running: Promise<void>[] = []
      for (const b of todo) {
        // 槽位充足时同步启动（保持启动序 = seq 序），否则等一个释放
        if (avail <= 0) await acquire()
        else avail -= 1
        running.push(launch(turnId, b, results))
      }
      await Promise.all(running)
      const out = list.map(b => results.get(b.id)
        ?? { id: b.id, seq: b.seq, status: 'error' as const, err: 'missing outcome' })
      settled.add(turnId)
      try {
        deps.onTurnEnd?.(turnId, out, 1)
      }
      catch { /* 观察者异常不挡主链路 */ }
      return out
    })()

    turns.set(turnId, done)
    trim()
    return done
  }

  function seed(turnId: number, outcomes: TurnRunOutcome[]): number {
    if (!Array.isArray(outcomes)) return 0
    let n = 0
    const ids: string[] = order.get(turnId) ? [...order.get(turnId)!] : []
    for (const o of outcomes) {
      if (!o || typeof o.id !== 'string' || !o.id) continue
      const key = turnRunKey(turnId, o.id)
      if (ledger.has(key)) continue
      ledger.set(key, { ...o, seq: typeof o.seq === 'number' && Number.isFinite(o.seq) ? o.seq : ids.length })
      if (!ids.includes(o.id)) ids.push(o.id)
      n += 1
    }
    if (ids.length) order.set(turnId, ids.sort((a, b) => (ledger.get(turnRunKey(turnId, a))?.seq ?? 0) - (ledger.get(turnRunKey(turnId, b))?.seq ?? 0)))
    return n
  }

  function outcomesOf(turnId: number): TurnRunOutcome[] {
    const ids = order.get(turnId) || []
    const out: TurnRunOutcome[] = []
    for (const id of ids) {
      const hit = ledger.get(turnRunKey(turnId, id))
      if (hit) out.push(hit)
    }
    return out
  }

  function activeTurns(): number[] {
    const out: number[] = []
    for (const [t, s] of starting) { if (s.size > 0) out.push(t)
    }
    return out.sort((a, b) => a - b)
  }

  return {
    submit,
    seed,
    abortTurn,
    abortAll(): void {
      for (const t of activeTurns()) abortTurn(t, 'aborted')
    },
    has: (turnId: number, blockId: string): boolean => ledger.has(turnRunKey(turnId, blockId)),
    outcomesOf,
    activeTurns,
    stats: () => ({ started, inFlight, maxInFlight, rounds }),
    reset(): void {
      ledger.clear()
      order.clear()
      turns.clear()
      starting.clear()
      marks.clear()
      settled.clear()
      waiters.length = 0
      avail = max
      inFlight = 0
      maxInFlight = 0
      started = 0
      rounds = 0
    },
  }
}
