// @desc 极简 markdown 渲染器：仅处理围栏代码块与内联代码，够用即可，不引入新依赖
// @why AI 回复含围栏脚本，需转 <pre><code> 才能正确显示为代码块；escapeHtml 内联以避免跨文件导入的扩展名问题
import { computed } from 'vue'
import type { Ref } from 'vue'

/** Markdown 围栏标记（三个反引号）；[WHY] 用 fromCharCode 而非字面量，避免本文件本身被误认为含代码块 */
const FENCE = String.fromCharCode(96).repeat(3)
/** 行内代码标记（单个反引号）；同 FENCE 理由 */
const INLINE_TICK = String.fromCharCode(96)

/**
 * 将 HTML 特殊字符转义为实体
 * [WHY] 内联而非跨文件导入：避免 strip-types 无法解析 .js 后缀 import 的问题
 * [CONSTRAINT] 覆盖 & < > " ' 五种字符；不处理 \u00a0 等实体已表达字符
 * @param s 待转义文本
 */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\'': '&#39;'
  } as Record<string, string>)[ch] || ch)
}

/** 切分后的最小渲染单元；content 已去围栏标记，可直接 escapeHtml */
interface MdSegment {
  type: 'text' | 'code'
  lang: string
  content: string
}

/**
 * 按 ``` 围栏切分文本为 text / code 段
 * [CONSTRAINT] 只识别行首的围栏（trimStart 后匹配）；不处理嵌套或未闭合围栏的错误恢复
 * [CHANGE-IMPACT] 未闭合围栏的尾段会整块归入 code，AI 回复被截断时可能表现异常
 * @param src 原始 markdown 文本
 */
function splitFences(src: string): MdSegment[] {
  const out: MdSegment[] = []
  if (!src) return out
  const lines = src.split('\n')
  let buf: string[] = []
  let inCode = false
  let lang = ''
  const flush = (type: 'text' | 'code', l: string): void => {
    if (buf.length) {
      out.push({ type, lang: l, content: buf.join('\n') })
      buf = []
    }
  }
  for (const line of lines) {
    const t = line.trimStart()
    if (t.startsWith(FENCE)) {
      if (!inCode) {
        flush('text', '')
        inCode = true
        lang = t.slice(FENCE.length).trim()
      } else {
        flush('code', lang)
        inCode = false
        lang = ''
      }
      continue
    }
    buf.push(line)
  }
  if (buf.length) out.push({ type: inCode ? 'code' : 'text', lang, content: buf.join('\n') })
  return out
}

/**
 * 处理行内语法：`code` 与 **bold**
 * [WHY] 先 escapeHtml 再做替换：替换目标为正则匹配字符，不会被转义为实体
 * [CONSTRAINT] 只支持单层内联；嵌套加粗 / 内联代码中的反引号不解析
 * [CHANGE-IMPACT] 新增语法须保证不会引入 XSS 风险（此处不做 sanitize）
 * @param text 纯文本段（不含围栏代码）
 */
/**
 * 块级 markdown 处理：标题 / 无序列表 / 有序列表 / 引用 / 分割线
 * [WHY] DONE 总结与 AI 回复常用 ### 标题 + 列表结构，仅 inlineFormat 会原样输出标记字符
 * [CONSTRAINT] 逐行处理不跨行合并；代码块已由 splitFences 剥离，不会进入本函数
 * [CHANGE-IMPACT] renderMarkdown 输出结构变化，v-html 渲染方的 CSS 需覆盖 h1-h3/ul/ol/blockquote/hr
 * @param text 纯文本段（不含围栏代码），可含多行
 */
function blockFormat(text: string): string {
  const out: string[] = []
  let list: 'ul' | 'ol' | null = null
  let para: string[] = []
  const flushPara = (): void => {
    if (para.length) {
      out.push(`<p>${inlineFormat(para.join('\n'))}</p>`)
      para = []
    }
  }
  const closeList = (): void => {
    if (list) { out.push(`</${list}>`); list = null }
  }
  for (const line of text.split('\n')) {
    const t = line.trim()
    const h = /^(#{1,3})\s+(.+)$/.exec(t)
    if (h) {
      flushPara(); closeList()
      const lv = h[1].length
      out.push(`<h${lv}>${inlineFormat(h[2])}</h${lv}>`)
      continue
    }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(t)) {
      flushPara(); closeList()
      out.push('<hr>')
      continue
    }
    const ul = /^[-*+]\s+(.+)$/.exec(t)
    if (ul) {
      flushPara()
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul' }
      out.push(`<li>${inlineFormat(ul[1])}</li>`)
      continue
    }
    const ol = /^\d+\.\s+(.+)$/.exec(t)
    if (ol) {
      flushPara()
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol' }
      out.push(`<li>${inlineFormat(ol[1])}</li>`)
      continue
    }
    if (/^>\s?/.test(t)) {
      flushPara(); closeList()
      out.push(`<blockquote>${inlineFormat(t.replace(/^>\s?/, ''))}</blockquote>`)
      continue
    }
    if (!t) { flushPara(); closeList(); continue }
    para.push(line)
  }
  flushPara(); closeList()
  return out.join('')
}

function inlineFormat(text: string): string {
  let html = escapeHtml(text)
  const re = new RegExp(`${INLINE_TICK}([^${INLINE_TICK}\\n]+)${INLINE_TICK}`, 'g')
  html = html.replace(re, '<code class="md-inline">$1</code>')
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  return html
}

/**
 * 把 markdown 文本渲染为安全 HTML 字符串
 * [WHY] 极简实现：只处理围栏代码 + 内联代码/加粗，够用即可，不引入 markdown 库
 * [CONSTRAINT] 输出已对代码内容做 escapeHtml；但内联格式语法本身不校验，调用方需用 v-html 渲染
 * @param src 原始 markdown；空串返回空串
 */
export function renderMarkdown(src: string): string {
  if (!src) return ''
  const segs = splitFences(src)
  return segs.map((s) => {
    if (s.type === 'code') {
      const cls = s.lang ? ` class="language-${escapeHtml(s.lang)}"` : ''
      return `<pre class="md-pre"><code${cls}>${escapeHtml(s.content)}</code></pre>`
    }
    return blockFormat(s.content)
  }).join('')
}

/**
 * 把 ref 包裹的 markdown 源转换为渲染后的 computed HTML
 * [CONSTRAINT] 返回 computed，随 source 变化自动重算；source.value 为 undefined/null 时按空串处理
 * @param source 响应式源文本；调用方需自行保证是 string 类型的 ref
 */
export function useMarkdown(source: Ref<string>) {
  return computed(() => renderMarkdown(source.value || ''))
}
