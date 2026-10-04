// @desc 用 markdown-it 渲染 Markdown（GFM 表格 / 删除线 / 链接 / 代码块全套）
// @why 自研极简渲染器只覆盖围栏+内联，表格/链接/删除线缺失；markdown-it 是标准实现，依赖已装
// @change-impact 输出 HTML 由 v-html 消费；TerminalPane（含 AI 提问卡）/ TimelineItem 依赖此模块；签名保持 renderMarkdown(src) 不变

import MarkdownIt from 'markdown-it'
// [restore-import-v1] computed 早前被按 auto-import 名单清理时误删：app 侧 unplugin-auto-import 兜底，
// 但 tsc --noEmit 与 vitest 无该插件 → 类型检查报 Cannot find name 'computed'
import { computed } from 'vue'
import type { Ref } from 'vue'

/**
 * markdown-it 单例
 * [WHY] html:false 关闭内联 HTML 透传 —— 防止 AI 回复中的 <script> 等注入；linkify 自动识别裸 URL
 * [CONSTRAINT] breaks:true 让 \n 视作 <br>（AI 常以单换行分隔条目）；不在构造期做 sanitize，靠 html:false 兜底
 * [CHANGE-IMPACT] 修改 options 会同时影响 TerminalPane / TimelineItem 两处的渲染结果
 */
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
})

// [md-class-compat-v1] 为 fenced code / inline code 补回自定义类名
// [WHY] markdown-it 默认输出 <pre><code class="language-x"> / 裸 <code>，与既有 CSS 的 .md-pre / .md-inline 不匹配
// [CONSTRAINT] 用 default renderer 保证转义与属性拼接逻辑不变；只追加 class
// [CHANGE-IMPACT] 两处消费方（TerminalPane / TimelineItem）依赖 .md-pre / .md-inline 样式生效
const _defaultFence = md.renderer.rules.fence!
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const html = _defaultFence(tokens, idx, options, env, self)
  return html.replace('<pre>', '<pre class="md-pre">')
}
const _defaultCodeInline = md.renderer.rules.code_inline!
md.renderer.rules.code_inline = (tokens, idx, options, env, self) => {
  const html = _defaultCodeInline(tokens, idx, options, env, self)
  return html.replace('<code>', '<code class="md-inline">')
}

/**
 * 把 markdown 文本渲染为 HTML 字符串
 * [WHY] html:false 已阻断原始 HTML；代码块内容由 markdown-it 自带 escape 保护
 * [CONSTRAINT] 空串返回空串（调用方 v-html 遇空串不渲染任何节点）
 * @param src 原始 markdown；空串返回空串
 */
/**
 * 补全缺失的 GFM 表格分隔行
 * [WHY] AI 生成总结时常省略分隔行；markdown-it 严格按 GFM 规范不识别 → 表格退化为纯文本（管道符原样显示）
 * [CONSTRAINT] 只在「连续 ≥2 行以 | 开头」且下一行非分隔行时补首行；跳过 fenced code 区块
 * [CHANGE-IMPACT] 影响所有消费方；若 AI 已正确输出分隔行，本函数为 no-op
 * @param src 原始 markdown
 */
function normalizeTables(src: string): string {
  const lines = src.split('\n')
  const out: string[] = []
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i]
    // [tilde-fence-v1] 报告 §3 P2：原只识别 ```，~~~ 围栏内容会被当普通行误处理
    if (/^\s*```/.test(cur) || /^\s*~~~/.test(cur)) inFence = !inFence
    out.push(cur)
    if (inFence) continue
    if (!/^\s*\|/.test(cur)) continue
    const next = lines[i + 1]
    if (!next) continue
    if (!/^\s*\|/.test(next)) continue
    // 已是分隔行：仅含 |、-、:、空白
    if (/^\s*\|[-\s:|]+\|\s*$/.test(next)) continue
    // [table-cellcount-escape-v1] 报告 §3 P2：原 split('|') 会把转义 \| 也计为列分隔符；
    // 先用占位符替换转义序列，再计数，最后还原。
    const cellCount = cur.replace(/\\\|/g, '\u0001').split('|').length - 2
    if (cellCount < 2) continue
    out.push(`| ${Array.from({ length: cellCount }).fill('---').join(' | ')} |`)
  }
  return out.join('\n')
}

/**
 * 把 markdown 文本渲染为 HTML 字符串
 * [WHY] html:false 阻断原始 HTML；normalizeTables 兜底 AI 偷懒省略的表格分隔行
 * [CONSTRAINT] 空串返回空串（调用方 v-html 遇空串不渲染任何节点）
 * @param src 原始 markdown；空串返回空串
 */
// [markdown-lru-cache-v1] 报告 §5.1.3：renderMarkdown 无缓存，每次输入/事件变化都全量重渲。
// [WHY] TerminalPane 提问卡的正文、TimelineItem 的 bodyHtml 均为 computed，依赖不变时不重复；
//       但 FileTree 弹窗 / WorklogPane 的 diff 渲染路径会因其他状态变化反复调用同文本。
// [CONSTRAINT] 以源文本为键；容量上限 200 条，超出淘汰最早项；空串直接返回避免占位。
const _mdCache = new Map<string, string>()
const MD_CACHE_MAX = 200

export function renderMarkdown(src: string): string {
  if (!src) return ''
  const hit = _mdCache.get(src)
  if (hit !== undefined) return hit
  const html = md.render(normalizeTables(src))
  if (_mdCache.size >= MD_CACHE_MAX) {
    const first = _mdCache.keys().next().value
    if (first !== undefined) _mdCache.delete(first)
  }
  _mdCache.set(src, html)
  return html
}

/**
 * 把 ref 包裹的 markdown 源转换为渲染后的 computed HTML
 * [CONSTRAINT] 返回 computed，随 source 变化自动重算；source.value 为 undefined/null 时按空串处理
 * @param source 响应式源文本；调用方需自行保证是 string 类型的 ref
 */
export function useMarkdown(source: Ref<string>) {
  return computed(() => renderMarkdown(source.value || ''))
}
