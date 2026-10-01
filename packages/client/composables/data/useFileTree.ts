import { ref } from 'vue'
import type { FileNode, FilesResponse } from '../../types'

// 模块级 children 缓存，所有 FileTree 递归实例共享
/** 文件树子节点缓存 */
const childrenCache = new Map<string, FileNode[]>()

/** 全局：正在加载子节点的路径集合 */
const globalLoadingChildren = ref<Set<string>>(new Set())
/**
 * 组合式函数 File Tree
 */
export function useFileTree() {
  const tree = ref<FileNode[]>([])
  /** 响应式引用：加载中 */
  const loading = ref(false)
  const copiedPath = ref('')
  const loadingChildren = globalLoadingChildren

  /** 加载 */
  async function load() {
    loading.value = true
    childrenCache.clear()
    loadingChildren.value.clear()
    try {
      const res = await fetch('/__ai/files?depth=1')
      const data: FilesResponse = await res.json()
      tree.value = data.tree || []
    } finally {
      loading.value = false
    }
  }

  async function loadChildren(path: string) {
    if (childrenCache.has(path) || loadingChildren.value.has(path)) return
    loadingChildren.value.add(path)
    try {
      const res = await fetch(`/__ai/files/children?path=${encodeURIComponent(path)}`)
      const data = await res.json()
      childrenCache.set(path, data.children || [])
    } catch {
      childrenCache.set(path, [])
    } finally {
      loadingChildren.value.delete(path)
      loadingChildren.value = new Set(loadingChildren.value)
    }
  }

  function getChildren(path: string): FileNode[] {
    return childrenCache.get(path) || []
  }

  function isChildrenLoading(path: string): boolean {
    return loadingChildren.value.has(path)
  }

  /** 复制路径 */
  async function copyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path)
      copiedPath.value = path
      setTimeout(() => { if (copiedPath.value === path) copiedPath.value = '' }, 1200)
    } catch { /* ignore */ }
  }

  return {
    tree,
    loading,
    copiedPath,
    loadingChildren,
    load,
    loadChildren,
    getChildren,
    isChildrenLoading,
    copyPath,
  }
}
