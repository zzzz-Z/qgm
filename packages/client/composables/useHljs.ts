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
 * @param text 待转义文本
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

/** 高亮文本长度上限：超过时跳过 hljs（主线程同步），直接走转义降级 */
// [hljs-size-guard-v1] 报告 §5.1.3：highlightAuto 同步执行，大文件会阻塞主线程；
// 阈值取 200KB 覆盖典型源码文件（含长日志），超过时视觉降级为纯文本。
const HLJS_MAX_LEN = 200_000

/** 统一高亮入口：DiffViewer（变更预览 / 工作日志的行级 diff）与 FileTree 弹窗共用。 */
export function highlightToHtml(text: string): string {
  if (!text) return ''
  if (text.length > HLJS_MAX_LEN) return escapeHtml(text)
  try {
    return hljs.highlightAuto(text, ['javascript', 'typescript']).value
  } catch {
    return escapeHtml(text)
  }
}
