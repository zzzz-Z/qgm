// [runtime-jsdoc-v1]
// [runtime-store-v1] 循环状态单一真相源
// 从 useAutoLoop / useAiWaiting 集中过来；状态变更的副作用由本文件的 watch 承担。
// 调用方只读 state、只调 action，不自己维护循环状态。
import { computed, watch } from 'vue'
import { defineStore } from 'pinia'
import { useStorage } from '@vueuse/core'
// [runtime-transport-wire-v1] mute/unMute 生效所依赖的真实 transport
import { getTransport } from '../composables/ai/useAiTransport'
// [runtime-kind-v3] 循环状态定义从 types.ts 复用，避免两套枚举
import type { LoopState } from '../composables/ai/auto-loop/types'

/** 运行时类型（类型别名） */
export type RuntimeKind = LoopState // [runtime-kind-v3] LoopState 已含 paused
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

/** 运行时 Pinia store：循环状态的单一真相源；状态变更副作用由本文件 watch 承担 */
export const useRuntime = defineStore('runtime-store', () => { // [runtime-fix2]
  /** 持久化到 sessionStorage 的运行时状态（跨标签页不共享，刷新后保留） */
  const state = useStorage<RuntimeState>(STORAGE_KEY, { ...INITIAL }, sessionStorage)

  /** 是否处于暂停态（kind = paused） */
  const isPaused = computed(() => state.value.kind === 'paused')
  /** 是否处于活动态（运行中或等待 AI 回复） */
  const isActive = computed(() => state.value.kind === 'running' || state.value.kind === 'waiting')
  /** 是否处于空闲态（无循环在跑） */
  const isIdle = computed(() => state.value.kind === 'idle')
  /** 是否已停止（循环结束或被用户中断） */
  const isStopped = computed(() => state.value.kind === 'stopped')

  /** 副作用：kind 切到 paused 时静音 transport；从 paused 恢复时解除静音 */
  watch(() => state.value.kind, (k, prev) => {
    if (k === 'paused') {
      try { getTransport().mute?.() } catch { /* 未就绪时忽略 */ }
    }
    if (prev === 'paused' && (k === 'waiting' || k === 'running')) {
      try { getTransport().unMute?.() } catch { /* 未就绪时忽略 */ }
    }
  })

  /** 启动循环：置为 running、写入目标、轮次归零、清空循环 id */
  function start(goal: string): void {
    state.value.kind = 'running'
    state.value.loopGoal = String(goal || '').trim()
    state.value.loopRound = 0
    state.value.loopId = ''
  }

  /** 进入等待态：等待 AI 回复或脚本回包 */
  function enterWaiting(): void {
    state.value.kind = 'waiting'
  }

  /** 暂停：置为 paused（watch 触发 transport 静音） */
  function pause(): void {
    state.value.kind = 'paused'
  }

  /** 从暂停恢复：回到 waiting（watch 触发 transport 解除静音） */
  function resume(): void {
    state.value.kind = 'waiting'
  }

  /** 停止循环：置为 stopped，保留当前轮次与目标供查看 */
  function stop(): void {
    state.value.kind = 'stopped'
  }

  /** 重置为 idle：清空循环上下文（id / 轮次 / 目标 / token / 花费 / 阶段） */
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
  function setStage(stage: RuntimeStage): void {
    state.value.stage = stage
  }

  /** 设置循环标识（每次 start 后由外部回填） */
  function setLoopId(id: string): void {
    state.value.loopId = String(id || '')
  }

  /** 设置用户备注：随下一轮反馈带给 AI */
  function setUserNote(note: string): void {
    state.value.userNote = String(note || '')
  }

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
})
