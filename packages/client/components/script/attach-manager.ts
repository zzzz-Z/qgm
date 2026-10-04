// [attach-manager-v1] 从 ScriptPanel.vue 抽出：附件簇（粘贴图片 / 拖文件 / 列表增删清）
import { TOAST_MEDIUM } from '../../utils/toast-durations'
import { readAsDataUrl } from './script-panel-utils'
import type { Ref } from 'vue'
import { uid } from '../../utils/id'

/** 附件条目 */
export interface AttachedFile {
  id: string
  name: string
  size: number
  kind: 'image' | 'text' | 'folder'
  content: string
  paths?: string[]
}

/** 附件簇依赖面 */
export interface AttachManagerDeps {
  attachedFiles: Ref<AttachedFile[]>
  script: Ref<string>
  fileSuccess: Ref<boolean>
}

/** 单文件上限：500KB */
export const MAX_ATTACH_BYTES = 500 * 1024

/**
 * 创建附件管理器
 * @param deps - 依赖面（共享 ref 由调用方持有，此处只操作）
 */
export function createAttachManager(deps: AttachManagerDeps) {
  // [attach-timer-v1] 单个成功提示的 timer 句柄，连续触发时先清旧的
  let fileSuccessTimer: ReturnType<typeof setTimeout> | null = null
  const { attachedFiles, script, fileSuccess } = deps
  const { toast } = useToast()

  /** 添加一个文件：图片走 DataURL、文本走原文本；超限跳过 */
  async function addAttachedFile(file: File): Promise<void> {
    if (file.size > MAX_ATTACH_BYTES) {
      toast(`附件 ${file.name} 超 ${fmtSize(MAX_ATTACH_BYTES)}，已跳过`, 'warn', TOAST_MEDIUM)
      return
    }
    const isImage = file.type.startsWith('image/')
    try {
      const content = isImage ? await readAsDataUrl(file) : await readAsText(file)
      attachedFiles.value.push({
        id: uid('at'),
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
    // [attach-parallel-v1] 并行读取：多图粘贴时耗时从 O(N) 降到 O(1)
    await Promise.all(images.map(f => addAttachedFile(f)))
  }

  /** 桌面拖入：接收所有文件并显示成功遮罩 */
  async function onDesktopDrop(e: DragEvent): Promise<void> {
    const files = Array.from(e.dataTransfer?.files || [])
    if (!files.length) return
    e.preventDefault()
    // [attach-parallel-v1] 并行读取：桌面多文件拖入时耗时从 O(N) 降到 O(1)
    await Promise.all(files.map(f => addAttachedFile(f)))
    fileSuccess.value = true
    // [attach-timer-v1] 报告 P2：连续两次 drop 时旧 timer 会提前清空新提示；先 clearTimeout
    if (fileSuccessTimer) clearTimeout(fileSuccessTimer)
    fileSuccessTimer = setTimeout(() => { fileSuccess.value = false; fileSuccessTimer = null }, 1500)
  }

  return { addAttachedFile, removeAttach, clearAll, onEditorPaste, onDesktopDrop }
}
