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
 * 将 HTML 特殊字符转义为实体
 * [WHY] hljs 未就绪 / 抛错时的降级渲染路径；避免 v-html 渲染原始标签造成 XSS
 * [CONSTRAINT] 覆盖 & < > " ' 五种字符；不处理实体已表达字符
 * [CHANGE-IMPACT] 与 DiffViewer.vue 内联版本功能重叠；若统一需同步两处
 * @param s 待转义文本
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => ({
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
