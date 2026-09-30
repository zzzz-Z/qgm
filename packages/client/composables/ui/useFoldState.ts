// [use-fold-state-v1] PLAN 5.4 折叠状态持久化（localStorage，key = sessionId:filePath）
import type { Ref } from 'vue'
import { useLocalStorage } from '@vueuse/core'

/** 折叠状态（接口） */
export interface FoldState {
  isOpen: (key: string, fallback?: boolean) => boolean
  setOpen: (key: string, open: boolean) => void
  toggle: (key: string, fallback?: boolean) => void
  all: Ref<Record<string, boolean>>
  clear: () => void
}

/** localStorage 键前缀（按模块区分） */
const PREFIX = 'airunner:fold:'

/**
 * 折叠面板状态（sessionId + scope 维度持久化到 localStorage）
 * [WHY] 原手写 loadMap/saveMap + deep watch 三件套与 vueuse useLocalStorage 完全等价，改用库实现减少维护面
 * [CONSTRAINT] sessionId/scope 变更不会自动迁移旧数据，调用方须以 :key 重建组件实例
 * @param sessionId 会话隔离键，空串回退为 'default'
 * @param scope 命名空间；同一会话内不同面板传不同值以避免键冲突
 */
export function useFoldState(sessionId: string, scope = 'default'): FoldState {
  /** [CONSTRAINT] 键格式必须与旧版 loadMap/saveMap 完全一致，否则已有用户数据会丢失 */
  const key = `${PREFIX}${sessionId || 'default'}:${scope}`

  /**
   * [WHY] vueuse 对 object 类型默认走 JSON 序列化，与旧版 JSON.stringify 兼容
   * [CONSTRAINT] 内部已含 SSR / 隐私模式兜底，无需再包 try/catch
   */
  const map = useLocalStorage<Record<string, boolean>>(key, {})

  /** 读取折叠态；未记录时返回 fallback（默认展开） */
  function isOpen(k: string, fallback = true): boolean {
    const v = map.value[k]
    return v === undefined ? fallback : v
  }

  /** 显式写入；[CHANGE-IMPACT] 必须整体替换对象，vueuse 依赖引用变更触发持久化 */
  function setOpen(k: string, open: boolean): void {
    map.value = { ...map.value, [k]: open }
  }

  /** 取反；与 isOpen 共用 fallback，保证首次点击方向与默认态一致 */
  function toggle(k: string, fallback = true): void {
    setOpen(k, !isOpen(k, fallback))
  }

  /** 清空当前 session:scope 下的全部折叠记录 */
  function clear(): void {
    map.value = {}
  }

  return { isOpen, setOpen, toggle, all: map, clear }
}
