// [attach-manager-v1] 从 ScriptPanel.vue 抽出：附件簇（粘贴图片 / 拖文件 / 列表增删清）
import { useToast } from '../../composables/ui/useToast'
import { readAsDataUrl } from './script-panel-utils'
import { fmtSize, readAsText } from '../../utils/format'
import type { Ref } from 'vue'

/** 附件条目 */
export interface AttachedFile {
  id: string
  name: string
  size: number
  kind: 'image' | 'text' | 'folder'
  content: string
  paths?: string[]
}

/** 单文件上限：500KB */
export const MAX_ATTACH_BYTES = 500 * 1024

/** 附件簇依赖面 */
export interface AttachManagerDeps {
  attachedFiles: Ref<AttachedFile[]>
  script: Ref<string>
  fileSuccess: Ref<boolean>
}

/**
 * 创建附件管理器
 * @param deps - 依赖面（共享 ref 由调用方持有，此处只操作）
 */
export function createAttachManager(deps: AttachManagerDeps) {
  const { attachedFiles, script, fileSuccess } = deps
  const { toast } = useToast()

  /** 添加一个文件：图片走 DataURL、文本走原文本；超限跳过 */
  async function addAttachedFile(file: File): Promise<void> {
    if (file.size > MAX_ATTACH_BYTES) {
      toast(`附件 ${file.name} 超 ${fmtSize(MAX_ATTACH_BYTES)}，已跳过`, 'warn', 4000)
      return
    }
    const isImage = file.type.startsWith('image/')
    try {
      const content = isImage ? await readAsDataUrl(file) : await readAsText(file)
      attachedFiles.value.push({
        id: `at-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        name: file.name || (isImage ? 'pasted-image' : 'file'),
        size: file.size,
        kind: isImage ? 'image' : 'text',
        content,
      })
    } catch {
      /* 读取失败静默忽略，不阻断后续附件 */
    }
  }

  /** 按 id 移除单个附件 */
  function removeAttach(id: string): void {
    attachedFiles.value = attachedFiles.value.filter(f => f.id !== id)
  }

  /** 清空编辑器与附件列表 */
  function clearAll(): void {
    script.value = ''
    attachedFiles.value = []
  }

  /** 编辑器粘贴：仅拦截图片，普通文本交给 CodeMirror */
  async function onEditorPaste(e: ClipboardEvent): Promise<void> {
    const items = Array.from(e.clipboardData?.items || [])
    const images: File[] = []
    for (const it of items) {
      if (it.type && it.type.startsWith('image/')) {
        const f = it.getAsFile()
        if (f) images.push(f)
      }
    }
    if (!images.length) return // 普通文本粘贴交给 CodeMirror 处理
    e.preventDefault()
    for (const f of images) await addAttachedFile(f)
  }

  /** 桌面拖入：接收所有文件并显示成功遮罩 */
  async function onDesktopDrop(e: DragEvent): Promise<void> {
    const files = Array.from(e.dataTransfer?.files || [])
    if (!files.length) return
    e.preventDefault()
    for (const f of files) await addAttachedFile(f)
    fileSuccess.value = true
    setTimeout(() => { fileSuccess.value = false }, 1500)
  }

  return { addAttachedFile, removeAttach, clearAll, onEditorPaste, onDesktopDrop }
}
