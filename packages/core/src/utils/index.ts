// utils barrel — 收敛下游 imports（HCLC §4）

export { fingerprintErrors } from './error-fingerprint.js'
export type { Fingerprint } from './error-fingerprint.js'

export { diffIndexes, readIndex, readIndexBefore, saveIndex, saveIndexBefore, scanIndex } from './file-index.js'
export type { FileIndex, IndexDiffEntry } from './file-index.js'

export { runHook } from './hooks.js'
export type { HookDef, HookEvent, HookResult } from './hooks.js'

export { parsePlanTodo } from './plan-parser.js'
export type { PlanTask } from './plan-parser.js'
