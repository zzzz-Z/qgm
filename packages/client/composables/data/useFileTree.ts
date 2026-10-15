import { ref } from 'vue'
import type { FileNode, FilesResponse } from '../../types'

// 模块级 children 缓存，所有 FileTree 递归实例共享
/**
 * [fs-watch-v1] 按变更路径枚举「已展开祖先目录」。
 * [WHY] 服务端广播的是单个文件路径；前端只关心已展开目录是否需要重拉。
 *   抽成纯函数便于单测：组件内嵌循环无法独立验证（变异验证会全绿）。
 * [CONSTRAINT] 返回 Set 无序；调用方自行去重、按需 loadChildren。
 * [CHANGE-IMPACT] FileTree.vue 的 files:changed 订阅依赖此枚举结果。
 */
export function computeAffectedDirs(paths: string[], isExpanded: (dir: string) => boolean): Set<string> {
  const affected = new Set<string>()
  for (const rel of paths) {
    if (!rel) continue
    const segs = rel.split('/')
    for (let i = 1; i < segs.length; i++) {
      const dir = segs.slice(0, i).join('/')
      if (isExpanded(dir)) affected.add(dir)
    }
    if (isExpanded(rel)) affected.add(rel)
  }
  return affected
}

/** 文件树子节点缓存 */
// [children-cache-lru-v1] 报告 §5.1.6：原 Map 无上限，长会话持续增长。
// 改用 LRU 上限 200：命中时刷新顺序，超出淘汰最旧。
const childrenCache = new Map<string, FileNode[]>()
const CHILDREN_CACHE_MAX = 200
function cacheGet(path: string): FileNode[] | undefined {
  const v = childrenCache.get(path)
  if (v) { childrenCache.delete(path); childrenCache.set(path, v) }
  return v
}
function cacheSet(path: string, value: FileNode[]): void {
  if (childrenCache.has(path)) childrenCache.delete(path)
  childrenCache.set(path, value)
  while (childrenCache.size > CHILDREN_CACHE_MAX) {
    const first = childrenCache.keys().next().value
    if (first === undefined) break
    childrenCache.delete(first)
  }
}

/** 全局：正在加载子节点的路径集合 */
const globalLoadingChildren = ref<Set<string>>(new Set())
/**
 * 组合式函数 File Tree
 */
// [load-seq-guard-v1] 并发 load 序列号：WorklogPane 同款守卫；旧响应到达时若序号已过期则丢弃
let _loadSeq = 0

export function useFileTree() {
  const tree = ref<FileNode[]>([])
  /** 响应式引用：加载中 */
  const loading = ref(false)
  const copiedPath = ref('')
  // [copy-path-timer-v1] 复制提示的定时器句柄；连续点击先清旧的避免提前清空
  let copiedPathTimer: ReturnType<typeof setTimeout> | null = null
  const loadingChildren = globalLoadingChildren

  /** 加载 */
  async function load() {
    // [load-seq-guard-v1] 捕获本次序号；await 后校验，过期即丢弃
    const mySeq = ++_loadSeq
    loading.value = true
    childrenCache.clear()
    loadingChildren.value.clear()
    try {
      const res = await fetch('/__ai/files?depth=1')
      if (mySeq !== _loadSeq) return
      if (!res.ok) { tree.value = []; return }
      const data: FilesResponse = await res.json()
      if (mySeq !== _loadSeq) return
      tree.value = data.tree || []
    } catch {
      if (mySeq !== _loadSeq) return
      tree.value = []
    } finally {
      if (mySeq === _loadSeq) loading.value = false
    }
  }

  async function loadChildren(path: string) {
    if (cacheGet(path) !== undefined || loadingChildren.value.has(path)) return
    const mySeq = _loadSeq
    loadingChildren.value.add(path)
    try {
      const res = await fetch(`/__ai/files/children?path=${encodeURIComponent(path)}`)
      // [loadchildren-no-cache-on-fail-v1] 失败不写缓存
      if (mySeq !== _loadSeq) return
      if (!res.ok) return
      const data = await res.json()
      if (mySeq !== _loadSeq) return
      cacheSet(path, data.children || [])
    } catch {
      // 静默：不写缓存，下次展开可重试
    } finally {
      loadingChildren.value.delete(path)
      loadingChildren.value = new Set(loadingChildren.value)
    }
  }

  /**
   * [fs-watch-v1] 使某目录的子节点缓存失效，由调用方随后调 loadChildren 重拉。
   * [WHY] 让订阅方（FileTree.vue）决定「谁需要重拉」，缓存层只负责「失效」这一原子动作。
   */
  function invalidateChildren(path: string): void {
    childrenCache.delete(path)
  }

  function getChildren(path: string): FileNode[] {
    return cacheGet(path) || []
  }

  function isChildrenLoading(path: string): boolean {
    return loadingChildren.value.has(path)
  }

  /** 复制路径 */
  async function copyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path)
      copiedPath.value = path
      if (copiedPathTimer) clearTimeout(copiedPathTimer)
      copiedPathTimer = setTimeout(() => { if (copiedPath.value === path) copiedPath.value = ''; copiedPathTimer = null }, 1200)
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
    invalidateChildren,
    computeAffectedDirs,
    copyPath,
  }
}
