// [draft-slots-v1] 从 ScriptPanel.vue 抽出：多草稿槽位读写 + 自动持久化 watch
import { watch } from 'vue'
import type { Ref } from 'vue'
import { LS_DRAFT_ACTIVE_KEY, LS_DRAFT_SLOTS_KEY } from '../../utils/storage'

/** 草稿槽位（多份草稿切换） */
export interface DraftSlot {
  id: string
  text: string
  ts: number
  name: string
}

/** 草稿管理器依赖面 */
export interface DraftSlotsDeps {
  script: Ref<string>
  draftSlots: Ref<DraftSlot[]>
  activeDraftId: Ref<string>
}

/**
 * 创建草稿槽位管理器
 * @param deps - 依赖面
 */
export function createDraftSlots(deps: DraftSlotsDeps) {
  const { script, draftSlots, activeDraftId } = deps
  let draftPersistTimer: ReturnType<typeof setTimeout> | null = null

  /** 从 localStorage 读草稿槽位列表（过滤非法项） */
  function readDraftSlots(): DraftSlot[] {
    try {
      const raw = localStorage.getItem(LS_DRAFT_SLOTS_KEY)
      if (!raw) return []
      const arr = JSON.parse(raw)
      return Array.isArray(arr)
        ? arr.filter((s: unknown): s is DraftSlot => {
            const o = s as Record<string, unknown>
            return typeof o?.id === 'string' && typeof o?.text === 'string'
          })
        : []
    } catch { return [] }
  }

  /** 读取上次活动草稿 id */
  function readActiveDraftId(): string | null {
    try { return localStorage.getItem(LS_DRAFT_ACTIVE_KEY) } catch { return null }
  }

  /** 把当前草稿列表与活动 id 写回 localStorage */
  function persistDraftSlots(): void {
    try { localStorage.setItem(LS_DRAFT_SLOTS_KEY, JSON.stringify(draftSlots.value)) } catch { /* 存储禁用时静默 */ }
    try { localStorage.setItem(LS_DRAFT_ACTIVE_KEY, activeDraftId.value) } catch { /* 存储禁用时静默 */ }
  }

  /** 更新或插入一个草稿槽位 */
  function upsertDraftSlot(id: string, text: string, name?: string): void {
    const i = draftSlots.value.findIndex(s => s.id === id)
    const item: DraftSlot = { id, text, ts: Date.now(), name: name || (i >= 0 ? draftSlots.value[i].name : id) }
    if (i >= 0) draftSlots.value[i] = item
    else draftSlots.value.push(item)
    persistDraftSlots()
  }

  // 编辑器内容变更 → 防抖 400ms 落盘到当前活动槽位
  watch(script, (v) => {
    if (draftPersistTimer) clearTimeout(draftPersistTimer)
    draftPersistTimer = setTimeout(() => {
      upsertDraftSlot(activeDraftId.value, String(v || ''))
    }, 400)
  })

  return { readDraftSlots, readActiveDraftId, persistDraftSlots, upsertDraftSlot }
}
