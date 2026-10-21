// [correction-policy-v1] turn-invalid 回灌决策（方案4）：把「是否纠正、怎么纠正」抽成纯函数便于裸测。
//
// [WHY] 油猴 / 无头侧已按契约丢弃不合规回复，并向工作台回传 `ai-runner:turn-invalid`（带 code）。
//   工作台据此决定是否向 AI 回灌一段纠正提示词（走既有 `ai-runner:fill` 通道，复用循环引擎的发送能力，
//   不另建旁路）。本模块只做决策，不碰 DOM、不调发送、不依赖任何 Vue 上下文。
//
// [CONSTRAINT] 仅 `TURN_NOT_JSON` / `TURN_TRUNCATED` 两种「信封彻底无效」的码才回灌：
//   · TURN_NOT_JSON —— 裸文本 / 无围栏代码：提示改用 ```json 信封，说明文字写进 content[].say。
//   · TURN_TRUNCATED —— 流式截断：提示拆小串行重发。
//   `TEXT_OUTSIDE_FENCE` 不在此回灌：它已被 readTurnFromRoot 回收成 say 块，无需重发，否则会重投已交付的 turn。
//
// [CONSTRAINT] 防循环两道闸（由调用方配合，本模块只给判据）：
//   [CHANGED 2026-10-21] 取消「仅活跃循环态才回灌」：手动会话里 AI 发无围栏回复也回灌一次（实测手动态整轮静默丢弃、零恢复）。
//   ① 同 sid 连续纠正上限 MAX_CORRECTIONS（=1，严格「回灌一次」），达上限改通知（让人工介入）。
//   ② 同正文签名只报一次（油猴侧 `_invalidReportedSig` 已去重；工作台再按 correctionCount 兜底）。

export const MAX_CORRECTIONS = 1

export type CorrectionAction = 'reinject' | 'notify' | 'skip'

export interface CorrectionDecision {
  /** reinject=回灌纠正提示词；notify=只通知人工；skip=既不回灌也不通知（如已回收的 TEXT_OUTSIDE_FENCE） */
  action: CorrectionAction
  /** action==='reinject' 时的纠正提示词 */
  prompt?: string
  /** action==='notify' 且已触达上限时为 true，用于文案区分 */
  exhausted?: boolean
}

export interface CorrectionInput {
  code: string
  /** 当前是否有活跃循环（autoTakeover.enabled）；[CHANGED 2026-10-21] 不再用于门控回灌，保留以稳定调用点，防循环改由次数上限兜底 */
  loopActive: boolean
  /** 该 sid 已连续纠正次数（调用方维护） */
  correctionCount: number
  /** 覆盖默认上限 */
  maxCorrections?: number
}

const REINJECTABLE = new Set(['TURN_NOT_JSON', 'TURN_TRUNCATED'])

/** 决策：给定违规码 + 循环态 + 已纠正次数，返回应当如何处置 */
export function decideCorrection(input: CorrectionInput): CorrectionDecision {
  const max = input.maxCorrections ?? MAX_CORRECTIONS
  // 只有「信封彻底无效」才回灌；围栏外文本等已被回收的类别直接 skip。
  if (!REINJECTABLE.has(input.code)) return { action: 'skip' }
  // 达上限：停止回灌，改通知人工介入。
  if (input.correctionCount >= max) return { action: 'notify', exhausted: true }
  const prompt = input.code === 'TURN_TRUNCATED'
    ? '上一条回复似乎被截断了。请把它拆成更小的步骤，每一步都用 ```json 围栏包住的 turn 信封回复，所有说明文字写进 content 里的 say 块，不要写在围栏外面。'
    : '你的上一条回复没有用 ```json 围栏包住的 turn 信封，已被按契约丢弃。请严格用信封格式回复，所有说明文字都写进 content[].say，不要写在围栏外面或作为裸文本。'
  return { action: 'reinject', prompt }
}
