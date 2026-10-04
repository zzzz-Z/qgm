// [script-panel-utils-v2] PLAN 4.7 阈值整改：从 ScriptPanel.vue 抽出的纯函数

/** 读 File 为 dataURL（用于附件预览） */

/**
 * 以 Data URL（base64）读取本地文件
 * [WHY] 附件以 data URL 形式嵌入 prompt；比 blob URL 更方便持久化与跨窗口传递
 * [CONSTRAINT] 读取失败 reject 原始事件对象；编码格式由浏览器决定（通常 data:*;base64,...）
 * [CHANGE-IMPACT] 结果会拼入发送给 AI 的 payload；大文件会显著放大 prompt 体积
 * @param file 浏览器 File 对象
 */
export function readAsDataUrl(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(String(r.result || ''))
    r.onerror = rej
    r.readAsDataURL(file)
  })
}

/** 判断坐标是否落在编辑器区域（用于拖放目标检测） */
export function isInEditor(x: number, y: number): boolean {
  try {
    const el = document.elementFromPoint(x, y)
    if (!el) return false
    return Boolean((el as HTMLElement).closest('.editor'))
  } catch { return false }
}
