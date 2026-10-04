// [tree-attach-v1] 从 ScriptPanel.vue 抽出：文件树拖拽 → 附件 / 目录展开 / 脚本拼装
import { isInEditor } from './script-panel-utils'
import type { FileNode, FilesReadResponse } from '../../types'
import type { Ref } from 'vue'
import { uid } from '../../utils/id'
import type { AttachedFile } from './attach-manager'

/**
 * 拉取文件夹内所有文件的路径（递归）
 * @param rootPath - 根路径
 */
async function fetchTreePaths(rootPath: string): Promise<string[]> {
  const out: string[] = []
  const walk = (nodes: FileNode[]) => {
    for (const n of nodes || []) {
      if (n.type === 'file') out.push(String(n.path || ''))
      else if (n.children) walk(n.children)
    }
  }
  try {
    const res = await fetch(`/__ai/files/tree?path=${encodeURIComponent(rootPath)}`)
    const data = await res.json() as { tree?: FileNode[] }
    walk(data.tree || [])
  } catch { /* 网络异常静默返回已收集的路径 */ }
  return out.filter(Boolean)
}

/**
 * 读取若干文件的源码内容
 * @param paths - 文件路径列表
 */
async function fetchFolderContents(paths: string[]): Promise<Array<{ path: string, content: string }>> {
  try {
    const res = await fetch('/__ai/files/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    })
    const data = await res.json() as FilesReadResponse
    return (data.files || []).filter(f => !f.error).map(f => ({ path: String(f.path), content: String(f.content || '') }))
  } catch { return [] }
}

/**
 * 创建树附件管理器
 * @param deps - 依赖面
 */
export function createTreeAttach(deps: { attachedFiles: Ref<AttachedFile[]> }) {
  const { attachedFiles } = deps

  /** 添加一批路径为附件：目录走 folder、单文件走 text 直接读源码 */
  async function addTreePaths(paths: string[]): Promise<void> {
    // [tree-attach-parallel-v1] 并行处理：拖入多文件时 IO 耗时从 O(N) 降到 O(1)。
    // [CONSTRAINT] attachedFiles.push 在并发下仍为原子操作（同帧内无 await 间隔），顺序无关。
    const pending = paths.filter(p => p && !attachedFiles.value.some(a => a.name === p))
    await Promise.all(pending.map(p => addOnePath(p)))
  }

  /** 处理单个路径：目录走 folder、文件走 text（并行安全） */
  async function addOnePath(p: string): Promise<void> {
    const tree = await fetchTreePaths(p)
    if (tree.length) {
      // 文件夹：只加一个 tag，发送时展开
      attachedFiles.value.push({
        id: uid('at'),
        name: p,
        size: tree.length,
        kind: 'folder',
        content: '',
        paths: tree,
      })
      return
    }
    // 单文件：直接读源码
    try {
      const res = await fetch('/__ai/files/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: [p] }),
      })
      const data = await res.json()
      const f = (data.files || [])[0]
      if (!f) return
      if (f.error) return
      const content = String(f.content || '')
      attachedFiles.value.push({
        id: uid('at'),
        name: p,
        size: content.length,
        kind: 'text',
        content,
      })
    } catch { /* 单个文件读取失败不影响其他 */ }
  }

  /** 树拖入编辑区：仅在编辑器范围响应 */
  function onTreeDrop(e: Event): void {
    const d = (e as CustomEvent).detail as { paths: string[], x: number, y: number }
    if (!d || !isInEditor(d.x, d.y)) return
    void addTreePaths(d.paths || [])
  }

  /** 脚本 + 附件 → 拼装成最终脚本文本（bash 用 #、cjs 用 //） */
  async function buildPromptWithAttachments(scriptText: string, files: AttachedFile[]): Promise<string> {
    if (!files.length) return scriptText
    const parts: string[] = []
    for (const f of files) {
      if (f.kind === 'folder' && f.paths && f.paths.length) {
        parts.push(`═════ 附件目录 ${f.name} (${f.paths.length} 文件) ═════`)
        const contents = await fetchFolderContents(f.paths)
        for (const cf of contents) {
          parts.push(`----- ${cf.path} -----`)
          for (const line of cf.content.split('\n')) parts.push(`${line}`)
        }
      } else if (f.kind === 'image') {
        parts.push(`═════ 附件图片 ${f.name} (${fmtSize(f.size)}) ═════`)
        // [image-channel-v2] 图片改走 FillPayload.images 独立通道，prompt 只留位置提示；
        // 避免 base64 在 prompt 与 images 双份携带导致剪贴板/上下文膨胀
        // [CHANGE-IMPACT] 若接收端未消费 images，图片将丢失（此提示仍在 prompt 中作为可观察信号）
        parts.push(`[图片已作为多模态附件随本请求发送]`)
      } else {
        parts.push(`═════ 附件 ${f.name} (${fmtSize(f.size)}) ═════`)
        for (const line of f.content.split('\n')) parts.push(`${line}`)
      }
    }
    parts.push('')
    return parts.join('\n') + scriptText
  }

  return {
    addTreePaths,
    onTreeDrop,
    buildPromptWithAttachments
  }
}
