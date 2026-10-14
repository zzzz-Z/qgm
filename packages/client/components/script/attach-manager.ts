// [attach-manager-v1] 从 ScriptPanel.vue 抽出：附件簇（粘贴图片 / 拖文件 / 列表增删清）
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

/**
 * [attach-no-size-limit-v1] 单文件上限已移除（用户要求）。
 * [WHY] 原 500KB 上限会把大图/大文件直接跳过（用户实测被拦）；但去掉后 base64 会成倍膨胀，
 *   经 postMessage → 剪贴板链路发送，超大文件仍可能触发浏览器侧限制（不是本层能保证的）。
 * [CONSTRAINT] 保留该常量供 UI 展示参考，实际判断不再拦截；若日后要恢复，改回数值判断即可。
 */
export const MAX_ATTACH_BYTES = Infinity

/**
 * 创建附件管理器
 * @param deps - 依赖面（共享 ref 由调用方持有，此处只操作）
 */
export function createAttachManager(deps: AttachManagerDeps) {
  // [attach-timer-v1] 单个成功提示的 timer 句柄，连续触发时先清旧的
  let fileSuccessTimer: ReturnType<typeof setTimeout> | null = null
  const { attachedFiles, script, fileSuccess } = deps

  /** 添加一个文件：图片走 DataURL、文本走原文本 */
  async function addAttachedFile(file: File): Promise<void> {
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
