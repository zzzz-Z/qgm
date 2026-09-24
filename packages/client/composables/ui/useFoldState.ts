// [use-fold-state-v1] PLAN 5.4 折叠状态持久化（localStorage，key = sessionId:filePath）
import type { Ref } from 'vue'
import { ref, watch } from 'vue'

/** localStorage 键前缀（按模块区分） */
const PREFIX = 'airunner:fold:'

/**
 * 执行 storage Key
 * @param sessionId - session Id
 * @param scope - scope
 */
function storageKey(sessionId: string, scope: string): string {
  return `${PREFIX + (sessionId || 'default')}:${scope}`
}

/**
 * 加载 Map
 * @param sessionId - session Id
 * @param scope - scope
 */
function loadMap(sessionId: string, scope: string): Record<string, boolean> {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(storageKey(sessionId, scope))
    if (!raw) return {}
    const j = JSON.parse(raw)
    if (!j || typeof j !== 'object') return {}
    const out: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(j)) out[k] = Boolean(v)
    return out
  } catch { return {} }
}

/**
 * 执行 save Map
 * @param sessionId - session Id
 * @param scope - scope
 * @param map - map
 */
function saveMap(sessionId: string, scope: string, map: Record<string, boolean>): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(storageKey(sessionId, scope), JSON.stringify(map))
  } catch { /* ignore */ }
}

/** 折叠状态（接口） */
export interface FoldState {
  isOpen: (key: string, fallback?: boolean) => boolean
  setOpen: (key: string, open: boolean) => void
  toggle: (key: string, fallback?: boolean) => void
  all: Ref<Record<string, boolean>>
  clear: () => void
}

/**
 * 组合式函数 Fold State
 * @param sessionId - session Id
 * @param scope - scope
 */
export function useFoldState(sessionId: string, scope = 'default'): FoldState {
  /** 响应式引用：映射 */
  const map = ref<Record<string, boolean>>(loadMap(sessionId, scope))

  /** 是否打开 */
  function isOpen(key: string, fallback = true): boolean {
    const v = map.value[key]
    return v === undefined ? fallback : v
  }

  /** 设置打开 */
  function setOpen(key: string, open: boolean): void {
    map.value = { ...map.value, [key]: open }
  }

  /** 切换 */
  function toggle(key: string, fallback = true): void {
    setOpen(key, !isOpen(key, fallback))
  }

  /** 清空 */
  function clear(): void {
    map.value = {}
  }

  watch(map, (v) => { saveMap(sessionId, scope, v) }, { deep: true })

  return { isOpen, setOpen, toggle, all: map, clear }
}
