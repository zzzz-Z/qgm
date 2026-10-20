// [turn-collect-v1] 块帧累积器：把「一块一块到的帧」拼回一个 turn 的完整块列表。
//
// [WHY] `ai:turn-end` 帧**不带块内容**（只带 `turnId` / `awaiting` / `blocks` 计数）。
//   执行器需要的是完整块列表，因此必须在客户端按 `turnId` 累积，等结束帧到达再一次性提交。
//   这层不能省：把块塞进结束帧会让每帧体积随块数线性膨胀，且结束帧必须在最后到（顺序契约）。
//
// [CONSTRAINT] 零依赖（不 import vue / 项目模块）：累积逻辑是「高频低可见」的代表——
//   块丢了只是少执行一个脚本、turn 串了只是跑到别的轮次，都不会立刻炸。
//   必须能脱离宿主被断言，否则它只会被 live 探针偶然发现。
//
// [CONSTRAINT] 同一 `turn|blockId` 后到覆盖先到（R2）：模型「改主意」时同 id 重发，
//   未执行的块应当被覆盖；是否重跑由执行器的 (turn,id) 账本决定，这里不承担。

/** 累积用的最小块形状（字段名与 `AiBlockDto` 一致，避免跨包 import） */
export interface CollectBlock {
  turnId?: number
  blockId?: string
  seq?: number
  type?: string
  [k: string]: unknown
}

/** 结束帧（字段名与 `AiTurnEndDto` 一致） */
export interface CollectTurnEnd {
  turnId?: number
  awaiting?: string
  /** [turn-mode-v1] 本轮性质的显式标记；旧服务端不传时按 awaiting 降级推断 */
  mode?: 'summary' | 'results' | 'user'
  blocks?: number
  skipped?: string[]
}

export interface TurnCollectorOptions {
  /**
   * 收口回调：拿到按 `seq` 排序的完整块列表。
   * [CONSTRAINT] 只在 `awaiting === 'results'`（存在 script 块）时调用 ——
   *   其余情况本 turn 就是总结 / 提问轮，没有可执行的东西。
   */
  onSubmit?: (turnId: number, blocks: CollectBlock[]) => void
  /** 同时保留的 turn 数上限（防漏收的结束帧导致无界累积） */
  maxTurns?: number
}

export interface TurnCollector {
  /** 收一个块帧；turnId/blockId 缺失即忽略（坏帧不该污染列表） */
  add: (block: CollectBlock | null | undefined) => void
  /** 收结束帧：取块 → 必要时 onSubmit → 清桶 */
  end: (end: CollectTurnEnd | null | undefined) => void
  /**
   * 运行时注入收口回调。
   * [WHY] 消费方（`useAiReplyHandlers`）只该依赖本模块，不该为了拿执行器而 import
   *   `useTurnRunner → useRunner → vueuse` 整条链；注入让依赖方向保持「调用方决定」。
   */
  setOnSubmit: (fn: ((turnId: number, blocks: CollectBlock[]) => void) | null) => void
  /** 某 turn 当前累积的块（按 seq；调试 / 面板用） */
  pending: (turnId: number) => CollectBlock[]
  /** 仍在累积的 turn（未收到结束帧） */
  openTurns: () => number[]
  /** 丢弃某 turn（取消 / 会话切换） */
  drop: (turnId: number) => void
  /** 清空 */
  reset: () => void
}

export const DEFAULT_MAX_COLLECT_TURNS = 20

/**
 * [hello-caps-v1] 服务端能力清单里是否含某类块。
 *
 * [WHY 抽成纯函数] 这条判定是典型的「高频低可见」逻辑：判错不抛异常，
 *   只表现为「脚本没执行」或「重复执行」，必须能脱离宿主被断言。
 *
 * [CONSTRAINT] **未握手 ⇒ 放行**（`caps` 为 null / undefined / 空）。
 *   ① 油猴通道根本没有 hello 帧 —— 把「无 hello」当成「不支持」会把正常回包整轮拦掉；
 *   ② 旧服务端不发 `ai:block`，放行也无害（它压根不会发）。
 *   只有**明确握过手且清单里没有**时才拦：那时再消费只会被静默丢弃。
 */
export function supportsBlock(caps: readonly string[] | null | undefined, type: string): boolean {
  if (!caps || caps.length === 0) return true
  if (!type) return true
  return caps.includes(type)
}

/** 从块列表派生「这一轮结束等什么」（与核心 deriveAwaiting 同义） */
export function collectAwaiting(blocks: readonly CollectBlock[]): 'results' | 'user' | 'none' {
  let hasScript = false
  let hasAsk = false
  for (const b of blocks) {
    if (b.type === 'script') hasScript = true
    else if (b.type === 'ask') hasAsk = true
  }
  if (hasScript) return 'results'
  if (hasAsk) return 'user'
  return 'none'
}

/**
 * [turn-mode-v1] 与核心 `deriveTurnMode` 同构：把「无 script 且无 ask ⇒ 总结轮」固化。
 * [CONSTRAINT] 本仓 `turn-collect` 与 `turn-frames` 是刻意的两份同构实现（一份可在浏览器裸跑，
 *   一份在服务端），改一处必须同步另一处，否则两侧对「总结轮」的判定会漂移。
 */
export function collectTurnMode(blocks: readonly CollectBlock[]): 'summary' | 'results' | 'user' {
  const awaiting = collectAwaiting(blocks)
  return awaiting === 'none' ? 'summary' : awaiting
}

export function createTurnCollector(opts: TurnCollectorOptions = {}): TurnCollector {
  const maxTurns = Math.max(1, Math.floor(opts.maxTurns ?? DEFAULT_MAX_COLLECT_TURNS))
  let onSubmit: ((turnId: number, blocks: CollectBlock[]) => void) | null = opts.onSubmit ?? null
  /** turnId → (blockId → block)；用 Map 保 id 去重，用 seq 排序 */
  const buckets = new Map<number, Map<string, CollectBlock>>()

  function bucketOf(turnId: number): Map<string, CollectBlock> {
    let b = buckets.get(turnId)
    if (!b) {
      b = new Map<string, CollectBlock>()
      buckets.set(turnId, b)
      // 插入序即最旧在前（Map 保序）；超限时淘汰最旧
      while (buckets.size > maxTurns) {
        const oldest = buckets.keys().next().value
        if (typeof oldest !== 'number' || oldest === turnId) break
        buckets.delete(oldest)
      }
    }
    return b
  }

  function sorted(turnId: number): CollectBlock[] {
    const b = buckets.get(turnId)
    if (!b) return []
    return [...b.values()].sort((x, y) => num(x.seq) - num(y.seq))
  }

  return {
    add(block: CollectBlock | null | undefined): void {
      if (!block || typeof block !== 'object') return
      const turnId = num(block.turnId)
      const blockId = typeof block.blockId === 'string' ? block.blockId : ''
      if (!blockId) return
      bucketOf(turnId).set(blockId, block)
    },
    end(end: CollectTurnEnd | null | undefined): void {
      if (!end || typeof end !== 'object') return
      const turnId = num(end.turnId)
      const blocks = sorted(turnId)
      buckets.delete(turnId)
      if (!blocks.length) return
      // [CONSTRAINT] 以块的真值判定，而不是信 end.awaiting：帧可能被中间层改写或缺失，
      //   而「有没有 script 块」是本地可验证的事实。
      if (collectAwaiting(blocks) !== 'results') return
      try {
        onSubmit?.(turnId, blocks)
      }
      catch { /* 观察者异常不挡收口 */ }
    },
    setOnSubmit(fn: ((turnId: number, blocks: CollectBlock[]) => void) | null): void { onSubmit = fn },
    pending: (turnId: number) => sorted(turnId),
    openTurns: () => [...buckets.keys()].sort((a, b) => a - b),
    drop(turnId: number): void { buckets.delete(num(turnId)) },
    reset(): void { buckets.clear() },
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
