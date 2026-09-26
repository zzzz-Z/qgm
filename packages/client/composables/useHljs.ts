import * as hljsNs from 'highlight.js/lib/core'
import * as javascriptNs from 'highlight.js/lib/languages/javascript'
import * as typescriptNs from 'highlight.js/lib/languages/typescript'
import type { HLJSApi } from 'highlight.js'

/** [p1-2-client-v1] 语言定义函数类型：从 registerLanguage 签名反推，避免依赖 highlight.js 内部导出名。 */
type LanguageFn = Parameters<HLJSApi['registerLanguage']>[1]

/** highlight.js 实例（ESM 默认导出，namespace.default 即 HLJSApi） */
const hljs: HLJSApi = hljsNs.default
/** JavaScript 语言语法定义 */
const javascript: LanguageFn = javascriptNs.default
/** TypeScript 语言语法定义 */
const typescript: LanguageFn = typescriptNs.default

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
