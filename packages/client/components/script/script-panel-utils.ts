// [script-panel-utils-v2] PLAN 4.7 阈值整改：从 ScriptPanel.vue 抽出的纯函数

/** 读 File 为 dataURL（用于附件预览） */

/**
 * 读取 As Data Url
 * @param file - file
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

/** 判断脚本是否为 bash（shebang 检测） */
export function isBashScript(scriptText: string): boolean {
  const first = (scriptText.split('\n', 1)[0] || '').trim()
  return /^#!\s*\/usr\/bin\/(?:env\s+)?bash\b/.test(first)
}
