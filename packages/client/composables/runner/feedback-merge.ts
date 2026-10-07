// [auto-feedback-merge-v1] 非循环自动回传合并窗：把「每块执行完立刻逐条回传」改为
//   「静默 Δ 后把本批结果合成一条回传」。与循环路径的 [round-merge-v1]（pending-scripts.ts）同型，
//   但独立实现——非循环路径没有 loopId / 循环实例状态，只有一条「执行结果流」。
//
// [WHY] 2026-10-06 19:16–19:40 实测 .ai-runner/logs/send.jsonl（取数时刻 19:5x，n=83）：
//   循环未激活的自动执行路径逐条 copyOutput 连发，相邻间隔 p50≈2.2s、最小 73ms（三连发），
//   一条 AI 回复的十余个块被放大成十余次提问，AI 端被高频出站打到暂停/限流。
//   循环路径已有合并窗收口，本路径此前零合并零节流。
// [CONSTRAINT] ① 单条时文案逐字等价（回归红线，同 round-merge 的单块短路）；
//   ② isActive 守卫拒绝即丢弃、不重排（停止/循环接管后不得有迟到出站）；
//   ③ flush 异常不上抛不阻断调用方（ScriptPanel 的 watch 回调）；④ Δ 可注入（测试置小值）；
//   ⑤ 本模块零依赖（不 import vue / 项目 composables），vitest 可裸跑真实驱动。
// [CHANGE-IMPACT] copyOutput 的直接出站改为入窗；copied 提示 / startAiWaiting / emit 移到 flush 时点，
//   单条回传最晚延迟 Δ 出站（相对 AI 生成耗时属小量）。

/** 单条待回传的执行结果（text 已由调用方 buildAiPrompt 构造完成） */
export interface FeedbackItem {
  text: string
  ok: boolean
  exit: number
  changes: Array<{ path: string, type: string }>
}

/**
 * 默认静默窗（Δ=3s）。
 * [WHY] 须大于「同一条回复的块间执行完成间隔」才能把一批合成一条：send.jsonl 实测该间隔
 *   p50≈2.2s（1.7–2.2s 密集段）⇒ 取 3s 覆盖主密度；4–10s 的稀疏长间隔可能仍被切开，
 *   属可接受残差——后续可用 send.jsonl 按 sid 复算分位再校准（口径与 inter-round-gap-probe 同）。
 * [CONSTRAINT] 改动此值须同步 feedback-merge.node-test.ts 的源码锚点断言。
 */
export const AUTO_FEEDBACK_MERGE_MS = 3000

/** 合并文案：单条逐字原样；多条加头部统计 + 每条独立小节（风格对齐循环路径的 buildRoundBatchPrompt） */
export function buildMergedFeedbackText(items: FeedbackItem[]): string {
  if (items.length === 1) return items[0]!.text
  const okN = items.filter(i => i.ok).length
  const head = `【合并回传】本批共 ${items.length} 次执行结果（成功 ${okN} · 失败 ${items.length - okN}）`
  const sections = items.map((it, i) => `── 结果 ${i + 1}/${items.length} ──\n${it.text}`)
  return [head, ...sections].join('\n\n')
}

export interface FeedbackMergeOpts {
  /** 静默窗时长，缺省 AUTO_FEEDBACK_MERGE_MS；测试可置小值 */
  delayMs?: number
  /** 到点时校验；返回 false ⇒ 丢弃整个缓冲且不重排（循环已激活：回传权归循环引擎） */
  isActive?: () => boolean
}

export interface FeedbackMerge {
  stage: (item: FeedbackItem) => void
  /** 清空缓冲并撤窗（调用方卸载 / 用户急停时用） */
  cancel: () => void
  pendingCount: () => number
}

/**
 * 创建合并窗。每次 stage 顺延窗口（静默判据，非定时快照——与 [round-merge-v1] 同型：
 * 「到点时缓冲是否还沉默」不能拿瞬时快照判，必须让每次到达都重置窗口）。
 */
export function createFeedbackMerge(
  flush: (items: FeedbackItem[], mergedText: string) => void,
  opts: FeedbackMergeOpts = {},
): FeedbackMerge {
  const delayMs = opts.delayMs ?? AUTO_FEEDBACK_MERGE_MS
  let buf: FeedbackItem[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  function doFlush(): void {
    timer = null
    const items = buf
    buf = []
    if (!items.length) return
    if (opts.isActive && !opts.isActive()) return
    try {
      const r = flush(items, buildMergedFeedbackText(items)) as unknown
      if (r instanceof Promise) r.catch(() => { /* 异步异常不上抛 */ })
    } catch { /* 同步异常同样不上抛：回传失败不得炸 ScriptPanel 的 watch 回调 */ }
  }
  return {
    stage(item: FeedbackItem): void {
      buf.push(item)
      if (timer) clearTimeout(timer)
      timer = setTimeout(doFlush, delayMs)
    },
    cancel(): void {
      if (timer) clearTimeout(timer)
      timer = null
      buf = []
    },
    pendingCount: () => buf.length,
  }
}
