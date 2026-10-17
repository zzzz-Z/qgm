// @ts-nocheck
// [tampermonkey-ts-rewrite-v1] IIFE 物理切分片段，非独立模块；跨片段符号在单文件检查下不可见。
//   全部片段 TS 化完成、按拼回后的联合视图接线后再移除本 pragma。

/**
 * 语言判定四级回退：className → DOM 邻近探测 → 内容特征 → 脚本头契约。
 * [WHY] 各站点代码块的标注方式不一致（有的只在 <code class> 上、有的只在头部按钮上、
 *   有的干脆不标），单一判据必然漏判；漏判的后果是脚本降级成 plain 文本，
 *   表现为「页面上渲染了但没执行」。
 * [CONSTRAINT] 白名单恒为 js / bash（脚本头契约兜底为 js）；不认识的标签返回 null，
 *   由调用方跳过——把 python/json 当 js 交给 node 必然语法错。
 */

/** 头部标签文本 → 语言；只认短标签，长句是正文不是标签 */
function langFromText(s: string | null | undefined): string | null {
  const t = String(s || '').trim().toLowerCase()
  if (!t || t.length > 24) return null
  if (/^(?:bash|sh|shell|zsh)\b/.test(t)) return 'bash'
  if (/^(?:js|javascript|cjs|commonjs|node|nodejs)\b/.test(t)) return 'js'
  return null
}

/**
 * 从 <code class="language-xxx"> 直接判语言。
 * [WHY] 代码块头的语言标签/复制按钮不进 <code>，取 className 比邻近 DOM 探测更可靠。
 */
function guessLangFromClass(el: Element | null): string | null {
  if (!el || !el.className) return null
  const m = String(el.className).match(/(?:language|lang)-([a-z0-9+#-]+)/i)
  if (!m) return null
  const raw = m[1].toLowerCase()
  if (raw === 'bash' || raw === 'sh' || raw === 'shell' || raw === 'zsh') return 'bash'
  if (raw === 'js' || raw === 'javascript' || raw === 'node' || raw === 'mjs' || raw === 'cjs') return 'js'
  return null
}

/** 向前找最多 3 个兄弟节点里的标签文本，再看包裹容器的头部元素 */
function guessLangFromDom(pre: Element): string | null {
  let sib = pre.previousElementSibling
  for (let i = 0; i < 3 && sib; i++, sib = sib.previousElementSibling) {
    const r = langFromText(sib.textContent)
    if (r) return r
  }
  const wrap = pre.closest('[class*="code"], [class*="md"], [class*="markdown"], [class*="block"]')
  if (wrap) {
    const cands = wrap.querySelectorAll('[class*="lang"], [class*="header"], [class*="title"], [class*="label"]')
    for (const c of cands) {
      const r = langFromText(c.textContent)
      if (r) return r
    }
  }
  return null
}

/**
 * 按内容特征猜语言。
 * [WHY] 站点输出常直接 `fs.readdirSync(...)` / `const x = ...`，无 require/module.exports，
 *   三级判定全 null ⇒ 整块被跳过降级为 plain 文本。
 * [CONSTRAINT] 只加高置信特征，避免把普通 Markdown 代码块（如纯 JSON 配置）误判为 js。
 */
function guessLangFromContent(text: string): string | null {
  const head = text.slice(0, 300)
  if (/^#!\s*\/usr\/bin\/env\s+bash/.test(head) || /^#!\s*\/bin\/bash/.test(head)) return 'bash'
  if (/^#!\s*\/usr\/bin\/env\s+node/.test(head)) return 'js'
  if (/\brequire\s*\(/.test(head)) return 'js'
  if (/\bmodule\.exports\b/.test(head)) return 'js'
  if (/\bprocess\.(?:exit|argv|env)\b/.test(head)) return 'js'
  if (/\bfs\.(?:readFileSync|writeFileSync|readdirSync|existsSync|statSync|mkdirSync|unlinkSync)\b/.test(head)) return 'js'
  if (/\bconsole\.log\s*\(/.test(head)) return 'js'
  if (/\bJSON\.(?:parse|stringify)\s*\(/.test(head)) return 'js'
  if (/^(?:const|let)\s+\w+\s*=/.test(head)) return 'js'
  if (/^(?:echo|cd\s|ls\s|mkdir|git\s|pnpm\s|npm\s|yarn\s|rm\s)/m.test(head)) return 'bash'
  if (/\bif\s+\[\s/.test(head) || /\bfi\b/.test(head) || /\$(/.test(head)) return 'bash'
  return null
}

/**
 * 取代码块的纯文本，剔除语法高亮行号。
 * [WHY] 部分站点每行前有 <span class="linenumber">N</span>，textContent 会把行号粘进代码，
 *   `#! /usr/bin/env node` 变成 `1#! /usr/bin/env node` ⇒ shebang / ^const 正则全失配。
 * [CONSTRAINT] 克隆节点再删，不动真实 DOM——站点的复制按钮绑定原节点。
 */
function codeTextOf(codeEl: Element): string {
  const clone = codeEl.cloneNode(true) as Element
  clone.querySelectorAll('.linenumber, .react-syntax-highlighter-line-number, [class*="line-number"]').forEach(n => n.remove())
  return (clone.textContent || '').replace(/^\n+|\n+$/g, '')
}
