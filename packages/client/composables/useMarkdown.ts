// @desc 极简 markdown 渲染器：仅处理围栏代码块与内联代码，够用即可，不引入新依赖
// @why AI 回复含围栏脚本，需转 <pre><code> 才能正确显示为代码块；escapeHtml 内联以避免跨文件导入的扩展名问题
import { computed } from 'vue'
import type { Ref } from 'vue'

/** Markdown 代码围栏标记 */
const FENCE = String.fromCharCode(96).repeat(3)
/** 行内代码的 Markdown 勾号（`） */
const INLINE_TICK = String.fromCharCode(96)

/**
 * 执行 escape Html
 * @param s - s
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

interface MdSegment {
  type: 'text' | 'code'
  lang: string
  content: string
}

/**
 * 切分 Fences
 * @param src - src
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
 * 执行 inline Format
 * @param text - text
 */
function inlineFormat(text: string): string {
  let html = escapeHtml(text)
  const re = new RegExp(`${INLINE_TICK}([^${INLINE_TICK}\\n]+)${INLINE_TICK}`, 'g')
  html = html.replace(re, '<code class="md-inline">$1</code>')
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  return html
}

/**
 * 渲染 Markdown
 * @param src - src
 */
export function renderMarkdown(src: string): string {
  if (!src) return ''
  const segs = splitFences(src)
  return segs.map((s) => {
    if (s.type === 'code') {
      const cls = s.lang ? ` class="language-${escapeHtml(s.lang)}"` : ''
      return `<pre class="md-pre"><code${cls}>${escapeHtml(s.content)}</code></pre>`
    }
    return inlineFormat(s.content)
  }).join('')
}

/**
 * 组合式函数 Markdown
 * @param source - source
 */
export function useMarkdown(source: Ref<string>) {
  return computed(() => renderMarkdown(source.value || ''))
}
