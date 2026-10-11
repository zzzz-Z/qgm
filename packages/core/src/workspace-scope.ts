// [multi-workspace-v1] 工作区作用域（AsyncLocalStorage）：让 /run 按 workspaceId 隔离 root 解析，
// 免去把 root 显式穿参到 38 个 getRoot()/env 消费文件（详见 docs/plan-multi-workspace-2026-10-11.md §5 D5）。
// [CONSTRAINT] 本文件不得 import config（config 反向依赖本文件做 getRoot 作用域化，单向防环）。
import { AsyncLocalStorage } from 'node:async_hooks'

/** 单次执行的工作区作用域：请求级工作区 id 与其 root */
export interface WorkspaceScope {
  workspaceId: string | null
  root: string
}

const scope = new AsyncLocalStorage<WorkspaceScope>()

/**
 * 在指定工作区作用域内执行回调：回调及其全部 await 延续里，
 * getRoot() / resolveScopedRoot() 都解析为该工作区的 root。
 * [WHY] /run 的执行链（runScript → post-run tsc/lint/overlay/snapshot）散布在多个模块，
 *   各自经 getRoot() 或 env 隐式取 root；ALS 把「本次运行属于哪个工作区」变成环境量，
 *   调用点一行不改即获得按请求隔离的 root（含并发运行互不串台）。
 * [CONSTRAINT] 回调内不得再 setRoot 切换活跃工作区——活跃态是注册表维度，作用域是请求维度。
 */
export function runWithWorkspace<T>(ws: WorkspaceScope, fn: () => T): T {
  return scope.run(ws, fn)
}

/**
 * 作用域感知的 root 解析：有作用域用作用域 root，否则回落 fallback（= config 的活跃 ROOT）。
 * [WHY] config.getRoot() 是 103 处调用的唯一入口；把分支收在这里，调用方零改动。
 */
export function getScopeRoot(fallback: string): string {
  return scope.getStore()?.root ?? fallback
}

/** 当前作用域的工作区 id；无作用域返回 null（= 未声明，等价活跃工作区） */
export function getScopeWorkspaceId(): string | null {
  return scope.getStore()?.workspaceId ?? null
}

/**
 * 供无法 import config 的模块（post-run / utils 内的本地 resolveRoot）统一使用：
 * 作用域 root → env.AI_RUNNER_ROOT → env.AIR_ROOT → process.cwd()。
 * [CHANGE-IMPACT] tsc/lint/overlay/compliance/error-files/plan-parser/error-fingerprint/file-index
 *   的本地 root 解析已改为消费本函数——并发运行时才不会解析到错误工作区。
 */
export function resolveScopedRoot(): string {
  return scope.getStore()?.root
    ?? process.env.AI_RUNNER_ROOT
    ?? process.env.AIR_ROOT
    ?? process.cwd()
}
