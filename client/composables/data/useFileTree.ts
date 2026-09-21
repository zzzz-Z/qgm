import { ref } from 'vue'
import type { FileNode, FilesResponse } from '../../types'

// 模块级 children 缓存，所有 FileTree 递归实例共享
const childrenCache = new Map<string, FileNode[]>()

const globalLoadingChildren = ref<Set<string>>(new Set())
export function useFileTree() {
  const tree = ref<FileNode[]>([])
  const loading = ref(false)
  const copiedPath = ref('')
  const loadingChildren = globalLoadingChildren

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

  async function loadChildren(p: string) {
    if (childrenCache.has(p) || loadingChildren.value.has(p)) return
    loadingChildren.value.add(p)
    try {
      const res = await fetch(`/__ai/files/children?path=${encodeURIComponent(p)}`)
      const data = await res.json()
      childrenCache.set(p, data.children || [])
    } catch {
      childrenCache.set(p, [])
    } finally {
      loadingChildren.value.delete(p)
      loadingChildren.value = new Set(loadingChildren.value)
    }
  }

  function getChildren(p: string): FileNode[] {
    return childrenCache.get(p) || []
  }

  function isChildrenLoading(p: string): boolean {
    return loadingChildren.value.has(p)
  }

  async function copyPath(p: string) {
    try {
      await navigator.clipboard.writeText(p)
      copiedPath.value = p
      setTimeout(() => { if (copiedPath.value === p) copiedPath.value = '' }, 1200)
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
