import { escapeHtml, highlightToHtml } from './useHljs'
import { renderMarkdown } from './useMarkdown'

/**
 * 文件内容 → 可挂 v-html 的 HTML。
 * [WHY] FileTree 与变更列表预览各自内联一份「.md 走 markdown、其余走 hljs」的分流逻辑，
 *   复制粘贴会随扩展名规则与降级策略演进分叉；抽成单点后两侧共用同一判据。
 * [CONSTRAINT] html:false 由 useMarkdown 内部保证，不透传原始 HTML；hljs 抛错时降级为转义纯文本。
 */

/** markdown 扩展名判据；大小写不敏感 */
const MARKDOWN_RE = /\.(?:md|markdown)$/i

/**
 * 判断路径是否为 markdown 文件。
 * @param path 文件相对路径；空值视为非 markdown
 */
export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_RE.test(path)
}

/**
 * 把文件内容渲染为 HTML 字符串。
 * @param content 文件原始内容；空串返回空串（不产生空壳标签）
 * @param path 文件相对路径，仅用于 markdown 分流判定
 */
export function renderFileContent(content: string, path: string): string {
  if (!content) return ''
  if (isMarkdownPath(path)) {
    try {
      return renderMarkdown(content)
    } catch {
      /* markdown 渲染异常时回退到源码高亮 */
    }
  }
  try {
    return highlightToHtml(content)
  } catch {
    return escapeHtml(content)
  }
}
