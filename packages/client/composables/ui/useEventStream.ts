// AIRUNNER-BATCH19-2-FIX-TS-SUFFIX: 用 .ts 后缀，node strip-types 与 tsc allowImportingTsExtensions 均可解析
// AIRUNNER-BATCH19-2-FIX5-JS: .js 后缀，tsc/vite 均接受

// ── [分区] 顶层 re-export 集中区 ──
// AIRUNNER-BATCH19-2-SPLIT-EVENT-STREAM: 实现已外移至 event-stream.ts，此处 re-export 保 API 稳定
export type { EventKind, StreamEvent } from './event-stream.js'

export { archiveEvents, clearEvents, emit, peekPendingAskKey, setPendingAskKey, takePendingAskKey, useEventBus } from './event-stream.js'
