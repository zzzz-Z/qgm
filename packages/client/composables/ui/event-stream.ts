// AIRUNNER-BATCH19-2-SPLIT-EVENT-STREAM: 从 useEventStream.ts 抽出的纯模块级状态与函数（无 useAiSite 依赖）
import { ref } from 'vue'

/** 事件类型枚举（ai: = AI 回包；run: = 运行阶段；loop: = 循环状态；rules: = 规则变化） */
export type EventKind
  = | 'ai:script' | 'ai:done' | 'ai:plain' | 'ai:multi' | 'ai:summary'
    | 'ai:ask' | 'ai:feedback'
    | 'ai:decision' | 'ai:need-files' | 'ai:stream'
    | 'run:start' | 'run:end' | 'run:error' | 'run:stage'
    | 'loop:round' | 'loop:static' | 'loop:finish'
    | 'rules:changed'

/**
 * 事件流单条记录
 * [CONSTRAINT] id 由 emit 内 seq 单调递增，跨会话不重置；persist 后从存储恢复 seq 峰值
 * [CHANGE-IMPACT] UI 时间线依赖 id 做 :key，人为重排/改写会引发渲染闪烁
 */
export interface StreamEvent {
  id: number
  ts: number
  kind: EventKind
  round?: number
  summary: string
  payload?: Record<string, unknown>
}

/** 事件队列上限；超过时按 FIFO 淘汰最旧项，防止长时间会话撑爆 localStorage 配额 */
const MAX_EVENTS = 500
/** localStorage 键；[CONSTRAINT] 与 loadEvents / saveEvents / clearEvents 三处严格配对，改名会丢历史事件 */
const STORAGE_KEY = '__ai_event_log'

/** 事件队列（模块级单例）；[CONSTRAINT] 更新走引用替换（`events.value = [...]`）而非就地 push，确保 shallowRef 语义下的依赖追踪 */
const events = ref<StreamEvent[]>(loadEvents())
/** 下一个事件 id；从历史事件峰值续接，避免刷新后 id 重复 */
let seq = events.value.reduce((m, e) => Math.max(m, Number(e.id) || 0), 0)

// [ask-pending-card] 用户提问 → 生成等待卡 → AI 回复后同 key 原地替换
/** 本次提问对应的 pending 事件 updateKey；模块级单例，由 useRunner 写入、App.vue 消费 */
const pendingAskKey = ref('')

/**
 * 派发一个事件入队（可含 updateKey 做原地更新）
 * [WHY] updateKey 让同一逻辑卡片的多次事件（如 ai:ask → run:start → run:end）复用一条记录，避免流式渲染时刷屏
 * [CONSTRAINT] 每轮调用都会写 localStorage（配额内）；事件数超 MAX_EVENTS 后 FIFO 淘汰
 * [CHANGE-IMPACT] updateKey 匹配不区分 kind（跨类型覆盖），是 run.ts / useRunner 的关键协作约定
 * @param kind 事件类型
 * @param summary 展示文案；updateKey 命中时覆盖旧 summary
 * @param opts.round 轮次编号（可选）；仅首次入队时写入
 * @param opts.payload 事件体（可选）；updateKey 命中时浅合并到旧 payload
 * @param opts.updateKey 稳定标识；相同 key 原地替换而非新增
 */
export function emit(kind: EventKind, summary: string, opts?: { round?: number, payload?: Record<string, unknown>, updateKey?: string }): void {
  const { updateKey, round, payload: rawPayload } = opts || {}
  const payload: Record<string, unknown> = { ...(rawPayload || {}), ...(updateKey ? { updateKey } : {}) }
  if (updateKey) {
    // [updatekey-fix] 只按 updateKey 匹配，允许跨 kind 覆盖（ai:ask → run:start 同一张卡）
    const idx = events.value.findIndex(e => String((e.payload as Record<string, unknown>)?.updateKey || '') === updateKey)
    if (idx >= 0) {
      const next = [...events.value]
      next[idx] = { ...next[idx], ts: Date.now(), summary, payload: { ...(next[idx].payload || {}), ...payload } }
      events.value = next
      saveEvents(events.value)
      return
    }
  }
  const ev: StreamEvent = { id: ++seq, ts: Date.now(), kind, summary, ...(round ? { round } : {}), ...(Object.keys(payload).length ? { payload } : {}) }
  events.value = [...events.value, ev]
  if (events.value.length > MAX_EVENTS) events.value = events.value.slice(-MAX_EVENTS)
  saveEvents(events.value)
}

/**
 * 清空事件队列并归零 seq；同步清理 localStorage
 * [CONSTRAINT] seq 归零是必要的 —— 否则下次刷新页面从存储恢复时峰值计算会错位
 * [CHANGE-IMPACT] 调用方多为用户手动清屏，不涉及业务数据回滚
 */
export function clearEvents(): void {
  events.value = []
  seq = 0
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
}

/**
 * 事件总线组合式入口
 * [CONSTRAINT] events 是模块级单例，多组件共享同一队列；直接传引用而非拷贝
 * [CHANGE-IMPACT] 增删返回值需同步检查 useEventStream 包装层的解构
 */
export function useEventBus() { return { events, emit, clearEvents } }

/**
 * 从 localStorage 反序列化历史事件（最多保留 MAX_EVENTS 条）
 * [CONSTRAINT] SSR / 隐私模式 / 解析失败一律返回空数组，不抛错
 * [CHANGE-IMPACT] 返回数组直接作为 events.value 初值；修改过滤逻辑会影响 seq 峰值计算
 */
function loadEvents(): StreamEvent[] {
  try {
    if (typeof localStorage === 'undefined') return []
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.slice(-MAX_EVENTS)
  } catch { return [] }
}

/**
 * 序列化事件列表到 localStorage（写入前裁剪至 MAX_EVENTS）
 * [CONSTRAINT] 配额超限时静默忽略，事件队列的运行时状态不受影响
 * [WHY] 持久化是为刷新页面后恢复时间线，非业务关键路径，失败不回滚
 * @param list 全量事件列表；内部 slice(-MAX_EVENTS) 后写入
 */
function saveEvents(list: StreamEvent[]): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(-MAX_EVENTS)))
  } catch { /* ignore */ }
}
/**
 * 记录本次提问的事件 updateKey（供后续 AI 回包原地替换卡片）
 * [CONSTRAINT] 单值语义 —— 同一时刻只追踪一次提问；并发提问会覆盖上一个 key
 * @param k 由调用方生成的事件 updateKey
 */
export function setPendingAskKey(k: string) { pendingAskKey.value = k }
/**
 * 读取并清空 pending key（消费语义）
 * [WHY] 用 take 而非 peek 保证同一 key 只被消费一次，避免多个回包竞争同一卡片
 * [CONSTRAINT] 无 pending 时返回空串，调用方需自行判空
 */
export function takePendingAskKey(): string {
  const k = pendingAskKey.value
  pendingAskKey.value = ''
  return k
}
/**
 * 只读取 pending key，不清空（探针语义）
 * [CONSTRAINT] 与 takePendingAskKey 相对；用于日志 / 断言，不应作为消费入口
 */
export function peekPendingAskKey(): string { return pendingAskKey.value }
