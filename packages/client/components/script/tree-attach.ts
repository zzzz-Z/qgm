// [tree-attach-v1] 从 ScriptPanel.vue 抽出：文件树拖拽 → 附件 / 目录展开 / 脚本拼装
import { isBashScript, isInEditor } from './script-panel-utils'
import { fmtSize } from '../../utils/format'
import type { FileNode, FilesReadResponse } from '../../types'
import type { Ref } from 'vue'
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
    for (const p of paths) {
      if (!p) continue
      if (attachedFiles.value.some(a => a.name === p)) continue
      const tree = await fetchTreePaths(p)
      if (tree.length) {
        // 文件夹：只加一个 tag，发送时展开
        attachedFiles.value.push({
          id: `at-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          name: p,
          size: tree.length,
          kind: 'folder',
          content: '',
          paths: tree,
        })
        continue
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
        if (!f) continue
        if (f.error) continue
        const content = String(f.content || '')
        attachedFiles.value.push({
          id: `at-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          name: p,
          size: content.length,
          kind: 'text',
          content,
        })
      } catch { /* 单个文件读取失败不影响其他 */ }
    }
  }

  /** 树拖入编辑区：仅在编辑器范围响应 */
  function onTreeDrop(e: Event): void {
    const d = (e as CustomEvent).detail as { paths: string[], x: number, y: number }
    if (!d || !isInEditor(d.x, d.y)) return
    void addTreePaths(d.paths || [])
  }

  /** 脚本 + 附件 → 拼装成最终脚本文本（bash 用 #、cjs 用 //） */
  async function buildScriptWithAttachments(scriptText: string, files: AttachedFile[]): Promise<string> {
    if (!files.length) return scriptText
    const isBash = isBashScript(scriptText)
    const p = isBash ? '#' : '//'
    const parts: string[] = []
    for (const f of files) {
      if (f.kind === 'folder' && f.paths && f.paths.length) {
        parts.push(`${p} ═════ 附件目录 ${f.name} (${f.paths.length} 文件) ═════`)
        const contents = await fetchFolderContents(f.paths)
        for (const cf of contents) {
          parts.push(`${p} ----- ${cf.path} -----`)
          for (const line of cf.content.split('\n')) parts.push(`${p} ${line}`)
        }
      } else if (f.kind === 'image') {
        parts.push(`${p} ═════ 附件图片 ${f.name} (${fmtSize(f.size)}) ═════`)
        parts.push(`${p} [图片数据无法嵌入，请在 AI 站点单独粘贴]`)
      } else {
        parts.push(`${p} ═════ 附件 ${f.name} (${fmtSize(f.size)}) ═════`)
        for (const line of f.content.split('\n')) parts.push(`${p} ${line}`)
      }
    }
    parts.push('')
    return parts.join('\n') + scriptText
  }

  return { addTreePaths, onTreeDrop, buildScriptWithAttachments }
}
