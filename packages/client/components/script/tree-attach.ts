// [tree-attach-v1] 从 ScriptPanel.vue 抽出：文件树拖拽 → 附件 / 目录展开 / 脚本拼装
import { isInEditor } from './script-panel-utils'
import type { FileNode, FilesReadResponse } from '../../types'
import { subscribeTreeDrop } from '../../composables/ui/drag-bus'
import type { TreeDropDetail } from '../../composables/ui/drag-bus'
import type { Ref } from 'vue'
import { uid } from '../../utils/id'
import type { AttachedFile } from './attach-manager'
// [fence-safe-v1] 附件内容与「# 相关文件源码」属**同一类**注入（源码原样进 prompt）⇒ 必须同源处理
import { pushFenced } from './prompt-builder'

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
  function onTreeDrop(d: TreeDropDetail): void {
    if (!d || !isInEditor(d.x, d.y)) return
    void addTreePaths(d.paths || [])
  }

  /** 订阅显式落点通道；返回取消订阅函数 */
  function registerTreeDrop(): () => void {
    return subscribeTreeDrop(onTreeDrop)
  }

  /** 脚本 + 附件 → 拼装成最终脚本文本（bash 用 #、cjs 用 //） */
  async function buildPromptWithAttachments(scriptText: string, files: AttachedFile[]): Promise<string> {
    if (!files.length) return scriptText
    // [fence-safe-v1] 附件正文一律**加围栏**（围栏长度按内容自适应）。
    // WHY: 附件内容是源码原样，与 `# 相关文件源码` 是同一条通道——不围栏时它落进页面是**普通文本**，
    //   页面内触顶探针扫得到其中的探针词表（例如用户拖进 `headless-inject*.ts` 自己那份源码）⇒
    //   自指误报「已达长度上限」并掐掉一整轮。这是 Channel D 的**第二个发射点**：
    //   只修 prompt-builder 那一处，等于「同一机制只堵了一个入口」（项目铁律：修被藏起来的机制先数入口）。
    // CONSTRAINT: 附件正文与 `----- path -----` 分隔行逐字符不变（AI 侧靠它区分多文件），只加外壳。
    const parts: string[] = []
    for (const f of files) {
      if (f.kind === 'folder' && f.paths && f.paths.length) {
        parts.push(`═════ 附件目录 ${f.name} (${f.paths.length} 文件) ═════`)
        const contents = await fetchFolderContents(f.paths)
        const body: string[] = []
        for (const cf of contents) {
          body.push(`----- ${cf.path} -----`)
          body.push(cf.content)
        }
        // 空目录内容不产出空围栏块（与原先「什么都不 push」等价）
        if (body.length) pushFenced(parts, body.join('\n'))
      } else if (f.kind === 'image') {
        parts.push(`═════ 附件图片 ${f.name} (${fmtSize(f.size)}) ═════`)
        // [image-channel-v2] 图片改走 FillPayload.images 独立通道，prompt 只留位置提示；
        // 避免 base64 在 prompt 与 images 双份携带导致剪贴板/上下文膨胀
        // [CHANGE-IMPACT] 若接收端未消费 images，图片将丢失（此提示仍在 prompt 中作为可观察信号）
        parts.push(`[图片已作为多模态附件随本请求发送]`)
      } else {
        parts.push(`═════ 附件 ${f.name} (${fmtSize(f.size)}) ═════`)
        pushFenced(parts, f.content)
      }
    }
    parts.push('')
    return parts.join('\n') + scriptText
  }

  return {
    addTreePaths,
    onTreeDrop,
    registerTreeDrop,
    buildPromptWithAttachments
  }
}
