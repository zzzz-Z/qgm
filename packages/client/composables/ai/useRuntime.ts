import { computed, watch } from 'vue'
import { useStorage } from '@vueuse/core'
// [runtime-no-pinia-v1] 从 pinia store 迁出为 composable singleton，API 语义与原 defineStore 等价
// [runtime-store-v1] 循环状态单一真相源
// 从 useAutoLoop / useAiWaiting 集中过来；状态变更的副作用由本文件的 watch 承担。
// 调用方只读 state、只调 action，不自己维护循环状态。
import { getTransport } from './useAiTransport.js'
import type { LoopState } from './auto-loop/types.js'

/** 运行时类型（类型别名） */
export type RuntimeKind = LoopState
/** 运行时阶段（类型别名） */
export type RuntimeStage = '' | 'plan' | 'implement' | 'verify'

/** 运行时状态（接口） */
export interface RuntimeState {
  kind: RuntimeKind
  loopId: string
  loopRound: number
  loopGoal: string
  stage: RuntimeStage
  userNote: string
}

/** sessionStorage 存储键：运行时状态的持久化位置 */
const STORAGE_KEY = 'ai-runner-runtime'

/** 初始运行时状态：所有字段取默认值（idle 空闲态） */
const INITIAL: RuntimeState = {
  kind: 'idle',
  loopId: '',
  loopRound: 0,
  loopGoal: '',
  stage: '',
  userNote: '',
}

function createRuntime() {
  /** 持久化到 sessionStorage 的运行时状态（跨标签页不共享，刷新后保留） */
  // [ssr-storage-guard-v1] 直接传 sessionStorage 在 Node/SSR 下会 ReferenceError（报告 §2.14）。
  // 传 undefined 让 vueuse 用默认 storage（浏览器 window.sessionStorage / SSR 下内存兜底）；
  // mergeDefaults:true 让旧快照缺字段时用 INITIAL 补齐，避免 schema 演进后 undefined。
  const state = useStorage<RuntimeState>(STORAGE_KEY, { ...INITIAL }, undefined, { mergeDefaults: true })

  const isPaused = computed(() => state.value.kind === 'paused')
  const isActive = computed(() => state.value.kind === 'running' || state.value.kind === 'waiting')
  const isIdle = computed(() => state.value.kind === 'idle')
  const isStopped = computed(() => state.value.kind === 'stopped')

  // [runtime-transport-wire-v1] kind 切到 paused / 从 paused 恢复时静音或解静音真实 transport
  // [mute-flag-symmetry-v1] 任何「离开 paused」的转移都须 unMute：
  // 原实现只处理 paused→waiting/running，paused→stopped→running 路径会残留静音（隐藏死锁）
  // [CONSTRAINT] immediate:true 让 sessionStorage 恢复的 paused 初值也同步 mute 真实 transport
  watch(() => state.value.kind, (k, prev) => {
    if (k === 'paused') {
      try { getTransport().mute?.() } catch { /* 未就绪时忽略 */ }
    } else if (prev === 'paused') {
      try { getTransport().unMute?.() } catch { /* 未就绪时忽略 */ }
    }
  }, { immediate: true })

  /** 启动循环：置为 running、写入目标、轮次归零、清空循环 id */
  function start(goal: string): void {
    state.value.kind = 'running'
    state.value.loopGoal = String(goal || '').trim()
    state.value.loopRound = 0
    state.value.loopId = ''
  }

  /** 进入等待态：等待 AI 回复或脚本回包 */
  function enterWaiting(): void { state.value.kind = 'waiting' }

  /** 暂停：置为 paused（watch 触发 transport 静音） */
  function pause(): void { state.value.kind = 'paused' }

  /** 从暂停恢复：回到 waiting（watch 触发 transport 解除静音） */
  function resume(): void { state.value.kind = 'waiting' }

  /** 停止循环：置为 stopped，保留当前轮次与目标供查看 */
  function stop(): void { state.value.kind = 'stopped' }

  /** 重置为 idle：清空循环上下文（id / 轮次 / 目标 / 阶段） */
  function reset(): void {
    state.value.kind = 'idle'
    state.value.loopId = ''
    state.value.loopRound = 0
    state.value.loopGoal = ''
    state.value.stage = ''
  }

  /** 设置当前轮次（非负数，非法输入视为 0） */
  function setRound(round: number): void {
    state.value.loopRound = Math.max(0, Number(round) || 0)
  }

  /** 轮次 +1：每完成一轮调用 */
  function bumpRound(): void {
    state.value.loopRound = Math.max(0, state.value.loopRound) + 1
  }

  /** 设置流水线阶段：plan / implement / verify 或空 */
  function setStage(stage: RuntimeStage): void { state.value.stage = stage }

  /** 设置循环标识（每次 start 后由外部回填） */
  function setLoopId(id: string): void { state.value.loopId = String(id || '') }

  /** 设置用户备注：随下一轮反馈带给 AI */
  function setUserNote(note: string): void { state.value.userNote = String(note || '') }

  return {
    state,
    isPaused,
    isActive,
    isIdle,
    isStopped,
    start,
    enterWaiting,
    pause,
    resume,
    stop,
    reset,
    setRound,
    bumpRound,
    setStage,
    setLoopId,
    setUserNote,
  }
}

let runtimeSingleton: ReturnType<typeof createRuntime> | null = null

/** 运行时状态 composable（singleton）；首次调用初始化，与 pinia defineStore 返回等价 API */
export function useRuntime() {
  if (!runtimeSingleton) runtimeSingleton = createRuntime()
  return runtimeSingleton
}
