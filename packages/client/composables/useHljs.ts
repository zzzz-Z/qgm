import * as hljsNs from 'highlight.js/lib/core'
import * as javascriptNs from 'highlight.js/lib/languages/javascript'
import * as typescriptNs from 'highlight.js/lib/languages/typescript'

/** highlight.js 实例 */
const hljs: any = (hljsNs as any).default ?? hljsNs
/** JavaScript 语言语法定义 */
const javascript: any = (javascriptNs as any).default ?? javascriptNs
/** TypeScript 语言语法定义 */
const typescript: any = (typescriptNs as any).default ?? typescriptNs

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)

/**
 * 执行 escape Html
 * @param s - s
 */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\'': '&#39;',
  }[ch] as string))
}

/** 统一高亮入口：DiffViewer 与 FileTree 弹窗共用。 */
export function highlightToHtml(text: string): string {
  if (!text) return ''
  try {
    return hljs.highlightAuto(text, ['javascript', 'typescript']).value
  } catch {
    return escapeHtml(text)
  }
}
