// @ts-nocheck
// [tampermonkey-ts-rewrite-v1] IIFE 物理切分片段，非独立模块；跨片段符号在单文件检查下不可见。
//   全部片段 TS 化完成、按拼回后的联合视图接线后再移除本 pragma。

/**
 * DOM → Markdown 反推。
 * [WHY] 站点把回复渲染成 <h3>/<p>/<ul>/<pre>，直接取 textContent 会把块级元素粘成一行：
 *   标记行（SCRIPT/DONE…）与正文粘连 ⇒ 首行判据失效；列表层级丢失 ⇒ 总结不可读。
 * [CONSTRAINT] 只覆盖常用标签；未知标签递归取子节点文本兜底。
 *   本函数与 headless-inject.ts 的同名实现必须语义一致——两通道对同一回复反推出不同文本
 *   会让「是否已推过」与「首行是什么标记」的判定分叉。
 */
function elToMd(node: Node | null): string {
  if (!node) return ''
  if (node.nodeType === 3) return node.textContent || ''
  if (node.nodeType !== 1) return ''
  const el = node as Element
  const tag = el.tagName.toLowerCase()
  const inner = (): string => Array.from(el.childNodes).map(c => elToMd(c)).join('')
  if (tag === 'br') return '\n'
  if (tag === 'hr') return '\n---\n\n'
  if (/^h[1-6]$/.test(tag)) return `${'#'.repeat(Number(tag.charAt(1)))} ${inner().trim()}\n\n`
  if (tag === 'p') return `${inner().trim()}\n\n`
  if (tag === 'ul' || tag === 'ol') {
    const out: string[] = []
    let i = 1
    for (const c of Array.from(el.children)) {
      if (c.tagName.toLowerCase() !== 'li') continue
      out.push((tag === 'ul' ? '- ' : `${i++}. `) + elToMd(c).trim())
    }
    return `${out.join('\n')}\n\n`
  }
  if (tag === 'pre') {
    const code = el.querySelector('code')
    const cls = code ? String(code.className || '') : ''
    const m = cls.match(/language-([a-z0-9]+)/i)
    // 用 codeTextOf 剔行号，与 extractLatestScript 的取值口径保持一致
    const src = codeTextOf(code || el)
    return `\`\`\`${m ? m[1] : ''}\n${src}\n\`\`\`\n\n`
  }
  if (tag === 'code') return `\`${el.textContent || ''}\``
  if (tag === 'blockquote') return `${inner().split('\n').map(l => `> ${l}`).join('\n')}\n\n`
  if (tag === 'table') {
    const rows: string[] = []
    for (const tr of Array.from(el.querySelectorAll('tr'))) {
      rows.push(`| ${Array.from(tr.children).map(c => elToMd(c).trim()).join(' | ')} |`)
    }
    return `${rows.join('\n')}\n\n`
  }
  return inner()
}

/**
 * 取某个回复容器的完整 Markdown。
 * [CONSTRAINT] 允许传 Document（取 body），供「容器缺失但确需整页」的调用方使用；
 *   正常路径一律传 latestAssistantRoot() —— 整页反推会把侧栏标题与用户消息拼进来。
 */
function extractReplyMd(root: Node | null): string {
  if (!root) return ''
  const node = (root as Document).nodeType === 9 ? (root as Document).body : root
  if (!node) return ''
  return elToMd(node).replace(/\n{3,}/g, '\n\n').trim()
}
