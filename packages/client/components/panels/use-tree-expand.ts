// [ui-p1c-tree-expand-v1] V4 组件瘦身：从 FileTree.vue 抽出展开态 + 持久化逻辑
import { reactive } from 'vue'
import type { FoldState } from '../../composables/ui/useFoldState'

/**
 * 目录展开态：内存 Set + useFoldState 持久化
 * [WHY] FileTree.vue 超 500 行 HCLC 红线；展开/折叠/持久化是自洽的一组状态，与渲染无关
 * [CONSTRAINT] loadChildren 由调用方注入——composable 不关心懒加载数据源
 * [CHANGE-IMPACT] expanded 的初始化必须发生在 setup 同步期（onMounted 前的 rehydrate 依赖它）
 */
export function useTreeExpand(fold: FoldState, loadChildren: (path: string) => void) {
  const expanded = reactive(new Set<string>())
  for (const [k, v] of Object.entries(fold.all.value)) {
    if (v) expanded.add(k)
  }

  /** 增量写：只改本次 toggle 涉及的 key，保留其他递归实例的展开态（报告 §2.6） */
  function persist(changedPath: string, open: boolean): void {
    const next: Record<string, boolean> = { ...fold.all.value }
    if (open) next[changedPath] = true
    else delete next[changedPath]
    fold.all.value = next
  }

  /** 展开/折叠某目录；展开时按需拉取子节点 */
  function toggle(path: string): void {
    const wasOpen = expanded.has(path)
    if (wasOpen) {
      expanded.delete(path)
    } else {
      expanded.add(path)
      loadChildren(path)
    }
    persist(path, !wasOpen)
  }

  /** 只读判断，不触发加载 */
  function isOpen(path: string): boolean {
    return expanded.has(path)
  }

  /** 刷新后 expanded 已从持久化恢复但子树未拉取；对每个已展开目录补拉一次 */
  function rehydrate(): void {
    for (const path of expanded) loadChildren(path)
  }

  return { expanded, toggle, isOpen, rehydrate }
}
