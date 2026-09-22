// utils barrel — 收敛下游 imports（HCLC 第7章）

export { fingerprintErrors } from './error-fingerprint.js'
export type { Fingerprint } from './error-fingerprint.js'

export { runHook } from './hooks.js'
export type { HookDef, HookEvent, HookResult } from './hooks.js'

export { diffIndexes, readIndex, saveIndex, scanIndex } from './index-index.js'
export type { FileIndex, IndexDiffEntry } from './index-index.js'

export { parsePlanTodo } from './plan-parser.js'
export type { PlanTask } from './plan-parser.js'
