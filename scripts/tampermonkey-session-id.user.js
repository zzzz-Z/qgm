/* eslint-disable ts/no-unused-vars, unused-imports/no-unused-vars -- 兼容 fs API 签名 / catch 兼容 */
// ==UserScript==
// @name         AI Runner · 会话 ID + 用量估算 + 回复回传 + fill 接收
// @namespace    ai-runner
// @version      1.4.5
// @description  回传会话 ID/用量/AI 回复到工作台；接收 fill/stop（修复千问 Slate 输入框）；DONE 携带完整注释块；回复签名按 assistant 容器识别（修复千问回传）
// @match        https://chat.deepseek.com/*
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @match        https://claude.ai/*
// @match        https://kimi.moonshot.cn/*
// @match        https://gemini.google.com/*
// @match        *://*.qianwen.com/*
// @match        *://*.qianwen.ai/*
// @match        *://*.aliyun.com/*
// @match        *://*.tongyi.cn/*
// @match        *://*.qianwen.cn/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
(function () {
  'use strict'

  const RULES = [
    { re: /chat\.deepseek\.com\/a\/chat\/s\/([\w-]+)/, n: 1 },
    { re: /chatgpt\.com\/c\/([\w-]+)/, n: 1 },
    { re: /chat\.openai\.com\/c\/([\w-]+)/, n: 1 },
    { re: /claude\.ai\/chat\/([\w-]+)/, n: 1 },
    { re: /kimi\.moonshot\.cn\/chat\/([\w-]+)/, n: 1 },
    { re: /gemini\.google\.com\/app\/([\w-]+)/, n: 1 },
    { re: /tongyi\.aliyun\.com\/qianwen\/([\w-]+)/, n: 1 },
    { re: /qianwen\.aliyun\.com\/[\w-]*\/?([\w-]{20,})/, n: 1 },
    // [qianwen-web-v1] 千问网页版（qianwen.com）会话 URL 规则
    // WHY: 主域名切换至 qianwen.com，会话形如 /chat/{id} 或 /c/{id} 或 /q/{id}
    // CONSTRAINT: 域名锚定 qianwen.com，避免误匹配其他站点；顺序置末尾保留既有优先级
    // CHANGE-IMPACT: 影响 extractId() 返回；未命中返回 ''，不影响其他站点
    { re: /(?:www\.)?qianwen\.com\/(?:chat|c|q)\/([\w-]+)/, n: 1 }
  ]

  // [replay-buf] 缓存最近 N 条外发消息，供刷新后重放
  const _msgBuf = []
  const _MSG_BUF_MAX = 50
  // [c1-bridge-v1] 消息去重（msgId）+ 断链队列 + 定期 drain
  let _msgSeq = 0
  // [fill-dedup-v1] 入站 fill/rotate 去重，防止 postMessage 重试/多窗口重复消费
  const _seenInbound = new Set()
  const _pending = []
  const _PENDING_MAX = 200
  function _nextMsgId() {
    _msgSeq = (_msgSeq + 1) >>> 0
    return `${Date.now().toString(36)}-${_msgSeq.toString(36)}`
  }
  function _trySend(p) {
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(p, '*')
        return true
      }
    } catch { /* ignore */ }
    return false
  }
  function post(payload) {
    if (!payload || typeof payload !== 'object') return
    if (!payload.msgId) payload.msgId = _nextMsgId()
    if (!payload.ts) payload.ts = Date.now()
    _msgBuf.push(payload)
    if (_msgBuf.length > _MSG_BUF_MAX) _msgBuf.shift()
    if (!_trySend(payload)) {
      _pending.push(payload)
      if (_pending.length > _PENDING_MAX) _pending.shift()
    }
  }
  function _drainPending() {
    if (!_pending.length) return
    if (!window.opener || window.opener.closed) return
    const items = _pending.splice(0, _pending.length)
    for (const p of items) _trySend(p)
  }
  setInterval(_drainPending, 1000)

  let lastId = ''
  let lastSid = ''

  function extractSidFromHash() {
    const m = location.hash.match(/(?:^#|&)sid=([\w.-]+)/)
    return m ? m[1] : ''
  }

  function extractId() {
    const href = location.href
    for (let i = 0; i < RULES.length; i++) {
      const m = href.match(RULES[i].re)
      if (m) return decodeURIComponent(m[RULES[i].n])
    }
    return ''
  }

  // [assistant-root-v1] 定位「最后一条 AI 回复」的容器，站点无关
  // WHY: 原实现硬编码 DeepSeek 的 .ds-assistant-message-main-content；
  //   千问（.chat-answers-card-wrap）等站点取不到 → 文本退回整页 document，
  //   而整页末 300 字符是输入框/页脚，AI 流式期间不变化 → 回复签名恒定 → 永不回传
  // CONSTRAINT: 按特异性从上到下取最后一个命中元素；全不命中返回 null 由调用方兜底为 document
  // CHANGE-IMPACT: findNewDone / extractLatestReplyText / bodySignature 三处共用
  const ASSISTANT_ROOT_SELECTORS = [
    '.ds-assistant-message-main-content', // DeepSeek
    '[data-message-author-role="assistant"]', // ChatGPT
    '.chat-answers-card-wrap', // 千问 / 通义
  ]
  function latestAssistantRoot() {
    for (let i = 0; i < ASSISTANT_ROOT_SELECTORS.length; i++) {
      const els = document.querySelectorAll(ASSISTANT_ROOT_SELECTORS[i])
      if (els.length > 0) return els[els.length - 1]
    }
    return null
  }

  function send() {
    const id = extractId()
    const sid = extractSidFromHash()
    let changed = false
    if (id && id !== lastId) { lastId = id; changed = true }
    if (sid !== lastSid) { lastSid = sid; changed = true }
    if (!changed) return
    try {
      if (window.opener && !window.opener.closed) {
        post({ type: 'ai-runner:session-id', id, sessionId: extractSidFromHash() })
      }
    } catch {}
  }

  send()

  let lastHref = location.href
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href
      send()
    }
  }, 500)

  let domTimer = null
  const observer = new MutationObserver(() => {
    if (domTimer) clearTimeout(domTimer)
    domTimer = setTimeout(send, 800)
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  // [c1-bridge-v1] body 存活检查（DOM 容错，detached 时重挂）
  setInterval(() => {
    if (!document.body || !document.body.isConnected) return
    try { observer.observe(document.body, { childList: true, subtree: true, characterData: true }) } catch { /* ignore */ }
  }, 3000)

  window.addEventListener('popstate', send)
  window.addEventListener('hashchange', send)

  // ===== 回复回传 =====
  function hash32(s) {
    let h = 0x811C9DC5
    for (let i = 0; i < s.length; i++) {
      h = Math.imul(h ^ s.charCodeAt(i), 0x1000193) >>> 0
    }
    return (h >>> 0).toString(16).padStart(8, '0')
  }

  const seenHashes = new Set()
  const seenDoneMarkers = new Set()
  let lastBodySig = ''

  function langFromText(s) {
    const t = String(s || '').trim().toLowerCase()
    if (!t || t.length > 24) return null
    if (/^(?:bash|sh|shell|zsh)\b/.test(t)) return 'bash'
    if (/^(?:js|javascript|cjs|commonjs|node|nodejs)\b/.test(t)) return 'js'
    return null
  }
  // [code-text-clean-v1] 从 <code class="language-xxx"> 直接判语言
  // [WHY] DeepSeek 代码块头的语言标签/复制按钮不进入 <code> 元素，取 className 比邻近 DOM 探测更可靠
  // [CONSTRAINT] 只认 cjs/js/bash 三种（与 extractLatestScript 白名单一致），其余返回 null 交给后续探测
  // [CHANGE-IMPACT] 与 guessLangFromDom / guessLangFromContent 组成三级回退，改单级不影响其他级
  function guessLangFromClass(el) {
    if (!el || !el.className) return null
    const m = String(el.className).match(/(?:language|lang)-([a-z0-9+#-]+)/i)
    if (!m) return null
    const raw = m[1].toLowerCase()
    if (raw === 'bash' || raw === 'sh' || raw === 'shell' || raw === 'zsh') return 'bash'
    if (raw === 'js' || raw === 'javascript' || raw === 'node' || raw === 'mjs' || raw === 'cjs') return 'js'
    return null
  }
  function guessLangFromDom(pre) {
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
  function guessLangFromContent(text) {
    const head = text.slice(0, 300)
    if (/^#!\s*\/usr\/bin\/env\s+bash/.test(head) || /^#!\s*\/bin\/bash/.test(head)) return 'bash'
    if (/^#!\s*\/usr\/bin\/env\s+node/.test(head)) return 'js'
    if (/\brequire\s*\(/.test(head)) return 'js'
    if (/\bmodule\.exports\b/.test(head)) return 'js'
    if (/\bprocess\.(?:exit|argv|env)\b/.test(head)) return 'js'
    // [js-content-broaden-v1] 补常见 Node/fs/语法特征
    // WHY: 千问输出的脚本常直接 `fs.readdirSync(...)` / `const x = ...`，无 require/module.exports → 三级判定全 null → 整块被跳过降级为 plain 文本（用户反馈"脚本当成文本传了过来"）
    // CONSTRAINT: 只加高置信特征（fs. 调用 / const|let 赋值 / console.log / => 箭头 / JSON.parse）；避免误伤普通 Markdown 代码块（如纯 JSON 配置）
    // CHANGE-IMPACT: 特征命中即判 js；与 headless-inject.ts 的同名函数必须同步
    if (/\bfs\.(?:readFileSync|writeFileSync|readdirSync|existsSync|statSync|mkdirSync|unlinkSync)\b/.test(head)) return 'js'
    if (/\bconsole\.log\s*\(/.test(head)) return 'js'
    if (/\bJSON\.(?:parse|stringify)\s*\(/.test(head)) return 'js'
    if (/^(?:const|let)\s+\w+\s*=/.test(head)) return 'js'
    if (/^(?:echo|cd\s|ls\s|mkdir|git\s|pnpm\s|npm\s|yarn\s|rm\s)/m.test(head)) return 'bash'
    if (/\bif\s+\[\s/.test(head) || /\bfi\b/.test(head) || /\$\(/.test(head)) return 'bash'
    return null
  }
  // [strip-line-numbers-v1] 剔除语法高亮行号 span（react-syntax-highlighter 等）
  // WHY: 千问代码块每行前有 <span class="linenumber ...">N</span>，textContent 把行号粘进代码 →
  //   "#! /usr/bin/env node" 变成 "1#! /usr/bin/env node" → shebang/^const 正则全失配 → 脚本降级成 plain
  // CONSTRAINT: 克隆节点再删，不动真实 DOM；选择器覆盖 .linenumber 与 react-syntax-highlighter-line-number
  // CHANGE-IMPACT: extractLatestScript 的 text 不再含行号；hash 与执行内容均为纯净代码
  function codeTextOf(codeEl) {
    const clone = codeEl.cloneNode(true)
    clone.querySelectorAll('.linenumber, .react-syntax-highlighter-line-number, [class*="line-number"]').forEach(n => n.remove())
    return (clone.textContent || '').replace(/^\n+|\n+$/g, '')
  }

  function extractLatestScript() {
    const pres = document.querySelectorAll('pre')
    let last = null
    let lastMarked = null
    for (const pre of pres) {
      // [code-text-clean-v1] 优先从 <pre><code> 取文本，避开代码块头的语言标签与「复制/下载」按钮文字
      // [WHY] pre.textContent 会把头部按钮文字并入首行，污染后 #! 锚点失配、语言判定失败导致整块跳过
      // [CONSTRAINT] 无 code 子元素时回退 pre 本身；去首尾空行逻辑保持原样
      const codeEl = pre.querySelector('code') || pre
      const text = codeTextOf(codeEl)
      if (!text) continue
      if (!text.includes('\n') && text.length < 120) continue
      // [code-text-clean-v1] 语言判定三级回退：className → DOM 邻近探测 → 内容特征
      let lang = guessLangFromClass(codeEl) || guessLangFromDom(pre) || guessLangFromContent(text) || null
      // [script-head-contract-fallback-v1] 脚本头契约：与 headless-inject.ts 该段保持严格同构
      // [WHY] 同款漏识别：AI 用非白名单语言标签（javascript/node/无标签）时三级判定得 null → 代码块被跳过 →
      //   前端只收到 plain 走 Markdown 渲染不执行（表现为「渲染了但没跑」）
      // [CONSTRAINT] 只认脚本头契约允许的两种形式（shebang / @desc）；本段与 headless-inject.ts 必须同改，避免双通道分叉
      // [CHANGE-IMPACT] 影响 classifyAndPost 的 kind 分流（line 429 kind:'script'）
      const _marked = /^#!\s*\/usr\/bin\/env\s+(?:node|bash)\b/m.test(text)
        || /^\s*\/\/\s*@desc\s*:/m.test(text)
        || /^\s*#\s*@desc\s*:/m.test(text)
      if (!lang && _marked) lang = 'js'
      if (lang !== 'cjs' && lang !== 'js' && lang !== 'bash') continue
      const item = { lang, code: text, hash: hash32(text) }
      last = item
      const marked = /^#!\s*\/usr\/bin\/env\s+(?:node|bash)\b/m.test(text)
        || /^\s*\/\/\s*@desc\s*:/m.test(text)
        || /^\s*#\s*@desc\s*:/m.test(text)
      if (marked) lastMarked = item
    }
    return lastMarked || last
  }

  // [md-fence-fallback-v1] DOM <pre> 提取失败时，从 Markdown 文本提取 ``` 围栏代码块
  // WHY: 千问等站点代码块不用标准 <pre><code> 结构，extractLatestScript 找不到 → 降级成 plain 文本
  // CONSTRAINT: 只从「最后一条 AI 回复」的 Markdown 里提取；语言标签白名单 js/bash/cjs/shell/sh/node
  // CHANGE-IMPACT: 与 extractLatestScript 互补，先 DOM 后 Markdown，不重复发送（hash 去重）
  function extractScriptFromMarkdown() {
    try {
      const root = latestAssistantRoot() || document
      const md = extractReplyMd(root)
      // 匹配 ```lang\n...``` 或 ```\n...```（无语言标签）
      const fenceRe = /```(\w*)\n([\s\S]*?)```/g
      let m
      let last = null
      while ((m = fenceRe.exec(md)) !== null) {
        const rawLang = (m[1] || '').toLowerCase()
        const code = m[2].replace(/^\n+|\n+$/g, '')
        if (!code || (!code.includes('\n') && code.length < 120)) continue
        let lang = rawLang === 'javascript' || rawLang === 'node'
          ? 'js'
          : rawLang === 'sh' || rawLang === 'shell'
            ? 'bash'
            : rawLang === 'cjs'
              ? 'cjs'
              : rawLang === 'js'
                ? 'js'
                : rawLang === 'bash'
                  ? 'bash'
                  : null
        if (!lang) lang = guessLangFromContent(code)
        if (lang !== 'cjs' && lang !== 'js' && lang !== 'bash') continue
        last = { lang, code, hash: hash32(code) }
      }
      return last
    } catch { return null }
  }

  // [fix-undef] 从页面取最新一条回复的纯文本（排除 pre 代码块，用于 handoff 总结判定）
  function extractLatestReplyText() {
    // [ask-full-text-v1] 返回最后一条 assistant 容器的完整 Markdown（含段落换行）
    // [WHY] 原实现只取全局最后一个叶子节点 → 多段回复被截成末段，@ask 前缀丢失
    // [CONSTRAINT] 复用 extractReplyMd（DOM→Markdown 反推）；容器缺失时回退 document
    try {
      const _root = latestAssistantRoot() || document
      return extractReplyMd(_root)
    } catch { return '' }
  }

  // [done-comments] 从代码块中提取「DONE 起始的连续注释块」
  // 返回：{ raw: string[], tagged: { [tag]: string }, text: string, firstLine: string }

  // [done-md-reconstruct-v1] DOM → Markdown 反推：允许 AI 输出纯 Markdown 总结，
  // 但 textContent 会把 <h3>/<p>/<ul> 粘成一行；需按标签结构重建 Markdown 源码
  // [CONSTRAINT] 只覆盖 DeepSeek 常用标签；未知标签递归取子节点文本（兜底）
  // [CHANGE-IMPACT] 输出直接喂给前端 renderMarkdown；改这里必须同步 headless-inject 的 elToMd
  function elToMd(node) {
    if (!node) return ''
    if (node.nodeType === 3) return node.textContent || ''
    if (node.nodeType !== 1) return ''
    const el = node
    const tag = el.tagName.toLowerCase()
    const inner = () => Array.from(el.childNodes).map(c => elToMd(c)).join('')
    if (tag === 'br') return '\n'
    if (tag === 'hr') return '\n---\n\n'
    if (/^h[1-6]$/.test(tag)) return `${'#'.repeat(Number(tag.charAt(1)))} ${inner().trim()}\n\n`
    if (tag === 'p') return `${inner().trim()}\n\n`
    if (tag === 'ul' || tag === 'ol') {
      const out = []
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
      // [strip-line-numbers-v1] 用 codeTextOf 剔除行号，与 extractLatestScript 保持一致
      const src = codeTextOf(code || el)
      return `\`\`\`${m ? m[1] : ''}\n${src}\n\`\`\`\n\n`
    }
    if (tag === 'code') return `\`${el.textContent || ''}\``
    if (tag === 'blockquote') return `${inner().split('\n').map(l => `> ${l}`).join('\n')}\n\n`
    if (tag === 'table') {
      const rows = []
      for (const tr of Array.from(el.querySelectorAll('tr'))) {
        rows.push(`| ${Array.from(tr.children).map(c => elToMd(c).trim()).join(' | ')} |`)
      }
      return `${rows.join('\n')}\n\n`
    }
    return inner()
  }

  function extractReplyMd(root) {
    if (!root) return ''
    const node = root.nodeType === 9 ? root.body : root
    if (!node) return ''
    return elToMd(node).replace(/\n{3,}/g, '\n\n').trim()
  }

  function findNewDone() {
    const _root = latestAssistantRoot() || document
    // [done-md-reconstruct-v1] 用 DOM→Markdown 反推替代 textContent（保留换行与结构）
    const summary = extractReplyMd(_root)

    // [done-plain-v1] 新协议：首行严格 DONE + 后续 Markdown 总结
    // [CONSTRAINT] 只匹配首个非空行恰好为 DONE；避免"我做了 DONE"类误判
    if (summary) {
      const firstLine = summary.split(/\r?\n/).find(l => l.trim().length > 0) || ''
      if (/^\s*DONE\s*$/.test(firstLine)) {
        const headMarker = hash32(`done-head|${summary.slice(0, 200)}|${summary.length}`)
        if (!seenDoneMarkers.has(headMarker)) {
          return { marker: headMarker, text: summary }
        }
      }
    }

    return null
  }

  function bodySignature() {
    // [assistant-root-v1] 优先用「最后一条 AI 回复」容器的文本做签名
    // WHY: 整页末 300 字符在千问这类站点是输入框/页脚，AI 流式期间恒定 → 无法触发回传
    // CONSTRAINT: 容器存在且文本非空才用其签名；否则退回整页末 300 字符（旧行为，保证其他站点不回归）
    const root = latestAssistantRoot()
    const rootText = root ? (root.textContent || '').replace(/\s+/g, ' ').trim() : ''
    const t = rootText || (document.body.textContent || '').replace(/\s+/g, ' ')
    return hash32(t.slice(-300))
  }

  // [debounce-flatten-v1] 单级 350ms 节流：原 replyObserver 与 classifyAndPost 共用 replyDebounce，
  //   每次 DOM 变化都重设 2000ms；AI 流式期间 DOM 持续抖动 → 核心逻辑永远被推迟到"最后一次变化后再 2s"才执行。
  // [CONSTRAINT] 350ms 是合并流式抖动的下限；lastBodySig / seenHashes / seenDoneMarkers 已保证同内容不重复 post。
  // [CHANGE-IMPACT] 弹窗感知延迟 ~2s → ~0.35s；classifyAndPost 改为同步执行，节流由 observerDebounce 单点承担。
  // [generating-gate-v1] 生成中不发送 script/plain
  // WHY: 千问等站点流式输出（打字机），350ms 防抖间隙内脚本只出了一半；partial 的 hash 每次都变 → seenHashes 失效，连发多条残缺脚本
  // CONSTRAINT: 以「停止生成」按钮可见且可用为"仍在生成"信号；生成结束后按钮消失 → DOM 变化再触发 classifyAndPost，此时取到完整内容
  // CHANGE-IMPACT: script/plain 延迟到生成结束；DONE 整行匹配不受影响（流式中不会误出 DONE 首行）
  function findStopGeneratingBtn() {
    const all = Array.from(document.querySelectorAll('button'))
    return all.find((b) => {
      const lbl = `${b.getAttribute('aria-label') || ''} ${b.textContent || ''} ${b.getAttribute('title') || ''}`
      return /停止生成|停止回答|停止输出|stop\s*generat|stop\s*stream|stop\s*response|stop\s*answer/i.test(lbl)
    }) || null
  }
  function isGenerating() {
    const btn = findStopGeneratingBtn()
    return Boolean(btn && !btn.disabled)
  }

  let observerDebounce = null
  function classifyAndPost() {
    try {
      if (!window.opener || window.opener.closed) return

      const doneMarker = findNewDone()

      if (doneMarker) {
        seenDoneMarkers.add(doneMarker.marker)
        post({
          type: 'ai-runner:reply',
          kind: 'done',
          site: location.origin,
          sessionId: extractSidFromHash(),
          text: doneMarker.text,
        })
        lastBodySig = bodySignature()
        return
      }

      // [generating-gate-v1] 流式输出未完，script/plain 一律等生成结束后再发
      if (isGenerating()) return

      // [md-fence-fallback-v1] DOM 提取失败时兜底 Markdown 围栏提取
      const s = extractLatestScript() || extractScriptFromMarkdown()
      if (s && !seenHashes.has(s.hash)) {
        seenHashes.add(s.hash)
        post({
          type: 'ai-runner:reply',
          kind: 'script',
          code: s.code,
          lang: s.lang,
          hash: s.hash,
          site: location.origin,
          sessionId: extractSidFromHash(),
        })
        lastBodySig = bodySignature()
        return
      }

      const sig = bodySignature()
      if (sig !== lastBodySig) {
        lastBodySig = sig
        post({
          type: 'ai-runner:reply',
          kind: 'plain',
          site: location.origin,
          sessionId: extractSidFromHash(),
          // [ask-text-v1] 补 text：前端 parseAsk 依赖此字段识别交互提问
          // [CONSTRAINT] extractLatestReplyText 返回最后 assistant 容器文本；缺失时前端退化为纯提示
          text: (() => { try { return extractLatestReplyText() || '' } catch { return '' } })(),
        })
      }
    } catch {}
  }

  const replyObserver = new MutationObserver(() => {
    if (observerDebounce) clearTimeout(observerDebounce)
    observerDebounce = setTimeout(classifyAndPost, 350)
  })

  // [stop-v2] 监听生命周期标志 + 重挂入口
  // [WHY] stop 需 disconnect 防止旧回复重放；下次 fill/rotate 前须能恢复监听
  // [CONSTRAINT] 声明顺序固定在 replyObserver 之后，避免 no-use-before-define
  // [CHANGE-IMPACT] 被 stop / fill / rotate 三个分支引用，改此处必须同步改三个触发点
  let _replyObserving = false
  function resumeReplyObserver() {
    if (_replyObserving) return
    try {
      replyObserver.observe(document.body, { childList: true, subtree: true, characterData: true })
      _replyObserving = true
    } catch { /* body 未就绪，下次 fill/rotate 再试 */ }
  }
  resumeReplyObserver()

  // ===== fill / rotate / new-session / stop =====
  // [stop-v3] 按钮未命中时以 Esc 键盘事件兜底（站点改文案/图标按钮漏配时仍有概率阻断）
  // [WHY] 纯文案匹配脆弱：DeepSeek/千问按钮改版即静默失效，AI 继续流式生成
  // [CHANGE-IMPACT] 返回值语义不变（true=按钮命中）；stop 分支据此打日志
  function clickStopGenerating() {
    try {
      const btn = findStopGeneratingBtn()
      if (btn && !btn.disabled) {
        btn.click()
        return true
      }
    } catch {}
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }))
    } catch {}
    return false
  }

  function findNewChatButton() {
    const all = Array.from(document.querySelectorAll('button, a, [role="button"]'))
    return all.find((el) => {
      const lbl = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('data-testid') || ''}`
      return /新建对话|新对话|新建聊天|新建会话|开启新对话|new\s*chat|new\s*conversation/i.test(lbl)
    }) || null
  }
  // [no-summary-v1] 删除总结交接：new-session 只切换会话，不再搬运 summary
  // [CHANGE-IMPACT] 上游 useAiWindowSend.sendNewSession 的 summary 字段到此为止不再消费
  function clickNewSession() {
    const btn = findNewChatButton()
    if (btn && !btn.disabled) {
      try { btn.click(); return true } catch { /* ignore */ }
    }
    const url = `${location.origin}/`
    if (location.href !== url && location.pathname !== '/') {
      location.href = url
      return true
    }
    return false
  }

  function findInputBox() {
    const qwen = document.querySelector('div[contenteditable="true"][role="textbox"]')
    if (qwen) return qwen
    const ta = document.querySelector('textarea:not([readonly]):not([disabled])')
    if (ta) return ta
    return document.querySelector('[contenteditable="true"]') || null
  }

  function findSendButton(input) {
    const qwenBtn = document.querySelector('button[aria-label="发送消息"]')
    if (qwenBtn && !qwenBtn.disabled) return qwenBtn
    const allClickable = Array.from(document.querySelectorAll('button, div[role="button"]'))
    const byLabel = allClickable.find((b) => {
      if (b.disabled || b.getAttribute('aria-disabled') === 'true') return false
      const lbl = [b.getAttribute('aria-label'), b.getAttribute('title'), b.textContent].filter(Boolean).join(' ')
      return /发送消息|^发送$|send\s*message|^send$/i.test(lbl)
    })
    if (byLabel) return byLabel
    if (input && input.form) {
      const sb = input.form.querySelector('button[type=submit]:not([disabled])')
      if (sb) return sb
    }
    return null
  }

  function sendEnter(box) {
    const opts = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      composed: true,
      isComposing: false,
    }
    box.dispatchEvent(new KeyboardEvent('keydown', opts))
    box.dispatchEvent(new KeyboardEvent('keypress', opts))
    box.dispatchEvent(new KeyboardEvent('keyup', opts))
  }

  // [image-paste-v2] DataURL → File：粘贴图片到富文本输入框（图片通道 L3 接收端）
  // [WHY] 工作台 FillPayload.images 传 DataURL 数组，需转 File 才能经 paste 被 Slate/ProseMirror 消费
  // [CONSTRAINT] 仅解析 data:image/*;base64 前缀；解析失败返回 null 由调用方跳过，不阻断文本填入
  // [CHANGE-IMPACT] 与 fillInput 同级；新增消费方 pasteImages（ai-runner:fill 分支）
  function dataUrlToFile(dataUrl, name) {
    try {
      const m = String(dataUrl || '').match(/^data:(image\/[\w.+-]+);base64,(.+)$/)
      if (!m) return null
      const mime = m[1]
      const bin = atob(m[2])
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const ext = (mime.split('/')[1] || 'png').replace('+xml', '')
      return new File([bytes], `${name || 'image'}.${ext}`, { type: mime })
    } catch { return null }
  }

  // [image-paste-v2] 把 DataURL 数组注入输入框
  // [WHY] 不同站点图片上传路径不同：Slate/ProseMirror 认 paste 事件的 clipboardData.items；部分站点走隐藏 input[type=file]
  // [CONSTRAINT] 先 paste 后 file-input 兜底；两步均失败静默（文本仍会照常填入，用户体验不倒退）
  // [CHANGE-IMPACT] 消费 ai-runner:fill 的 images 字段；构造 File / DataTransfer / ClipboardEvent
  function pasteImages(box, images) {
    if (!box || !Array.isArray(images) || !images.length) return
    const files = []
    for (let i = 0; i < images.length; i++) {
      const f = dataUrlToFile(images[i], `pasted-image-${i}`)
      if (f) files.push(f)
    }
    if (!files.length) return

    // 1) 优先 paste：Slate/ProseMirror 走此路径
    try {
      const dt = new DataTransfer()
      for (const f of files) dt.items.add(f)
      const ev = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      })
      try { Object.defineProperty(ev, 'clipboardData', { value: dt }) } catch { /* clipboardData 构造后只读，defineProperty 兜底 */ }
      box.focus()
      box.dispatchEvent(ev)
    } catch { /* fallthrough: paste 不被支持时走 file input */ }

    // 2) 兜底：找隐藏 input[type=file] 塞 FileList + change 事件
    try {
      const input = document.querySelector('input[type=file]')
      if (input) {
        const dt2 = new DataTransfer()
        for (const f of files) dt2.items.add(f)
        try { input.files = dt2.files } catch { /* 部分浏览器 security 拒写 files，交由 change 事件触发站点自身逻辑 */ }
        input.dispatchEvent(new Event('change', { bubbles: true }))
      }
    } catch { /* ignore */ }
  }

  // ⭐ 核心修复：Slate.js / React 富文本用 ClipboardEvent('paste')
  function fillInput(box, text) {
    if (!box) return

    if (box.tagName === 'TEXTAREA' || box.tagName === 'INPUT') {
      const proto = box.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
      if (setter) setter.call(box, text)
      else box.value = text
      box.dispatchEvent(new Event('input', { bubbles: true }))
      box.dispatchEvent(new Event('change', { bubbles: true }))
      return
    }

    if (box.isContentEditable) {
      box.focus()

      // 清空
      try {
        const sel = window.getSelection()
        const range = document.createRange()
        range.selectNodeContents(box)
        sel.removeAllRanges()
        sel.addRange(range)
        document.execCommand('delete', false, null)
      } catch {}

      // 模拟粘贴（Slate 官方识别路径）
      let pasted = false
      try {
        const dt = new DataTransfer()
        dt.setData('text/plain', text)
        const ev = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: dt,
        })
        try { Object.defineProperty(ev, 'clipboardData', { value: dt }) } catch {}
        box.dispatchEvent(ev)
        pasted = box.textContent.trim().length > 0
      } catch {}

      // 兜底：insertText
      if (!pasted) {
        try {
          box.dispatchEvent(new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertText',
            data: text,
          }))
          document.execCommand('insertText', false, text)
          box.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertText',
            data: text,
          }))
        } catch {}
      }

      // 最后补一个普通 input，兼容非 Slate 的 React
      try {
        box.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: text,
        }))
      } catch (e) {
        box.dispatchEvent(new Event('input', { bubbles: true }))
      }

      // [qianwen-react-v1] React 受控 contenteditable 兜底
      // WHY: 千问输入框为 React + Tailwind 实现，上方 paste/insertText 若被 React 合成事件吞掉需显式告知状态变化
      // CONSTRAINT: 仅在 box 具备 React fiber/props 内部属性、且内容仍为空时激活；无属性时跳过，避免污染非 React 站点
      // CHANGE-IMPACT: 与上方 paste/insertText 为"或"关系，任一成功即可；不影响既有站点行为
      try {
        const _isReactBox = Object.keys(box).some(k =>
          k.startsWith('__reactFiber$') || k.startsWith('__reactProps$'))
        if (_isReactBox && (box.textContent || '').trim().length === 0) {
          box.focus()
          document.execCommand('insertText', false, text)
          box.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertText',
            data: text,
          }))
        }
      } catch { /* React 兜底失败不阻断主流程 */ }
    }
  }

  function doSend(box) {
    const btn = findSendButton(box)
    if (btn) {
      try { btn.click() } catch (e) { sendEnter(box) }
    } else {
      sendEnter(box)
    }
    setTimeout(() => {
      const stillHas = (box.textContent || box.value || '').trim().length > 0
      if (stillHas) {
        console.warn('[ai-runner] 发送可能失败，补一次 Enter')
        sendEnter(box)
      }
    }, 400)
  }

  window.addEventListener('message', (e) => {
    const d = e.data
    if (!d || typeof d !== 'object') return

    if (d.type === 'ai-runner:fill') {
      resumeReplyObserver() // [stop-v2] stop 后首次 fill 恢复回复监听
      if (d.msgId && _seenInbound.has(d.msgId)) return
      if (d.msgId) { _seenInbound.add(d.msgId); if (_seenInbound.size > 200) _seenInbound.delete(_seenInbound.values().next().value) }
      const prompt = String(d.prompt || '')
      if (!prompt) return
      const box = findInputBox()
      if (!box) { console.warn('[ai-runner] 未找到输入框'); return }
      const prevHref = location.href
      const replySrc = e.source
      // [image-paste-v2] 图片先于文本注入：图片上传多为异步，先占位可避免文本覆盖图片区
      // [CONSTRAINT] images 缺省或非数组时短路，保持旧行为（无图片路径零变化）
      // [CHANGE-IMPACT] 消费 FillPayload.images（v3 通道）；缺 images 字段时行为不变
      const imgs = Array.isArray(d.images) ? d.images : []
      if (imgs.length) pasteImages(box, imgs)
      fillInput(box, prompt)
      setTimeout(doSend, 300, box)
      // [url-updated] 发送后轮询 URL 变化并回传（最多 8s）
      let urlTries = 0
      const urlPoll = setInterval(() => {
        urlTries += 1
        if (location.href !== prevHref && location.href !== 'about:blank') {
          clearInterval(urlPoll)
          const payload = { type: 'ai-runner:url-updated', url: location.href, id: extractId() }
          try {
            const target = replySrc || window.opener
            if (target) target.postMessage(payload, '*')
          } catch { /* ignore */ }
          return
        }
        if (urlTries > 32) clearInterval(urlPoll)
      }, 250)
      return
    }

    if (d.type === 'ai-runner:rotate') {
      resumeReplyObserver() // [stop-v2] stop 后首次 rotate 恢复回复监听
      if (d.msgId && _seenInbound.has(d.msgId)) return
      if (d.msgId) { _seenInbound.add(d.msgId); if (_seenInbound.size > 200) _seenInbound.delete(_seenInbound.values().next().value) }
      const instruction = String(d.instruction || '')
      if (!instruction) return
      const box = findInputBox()
      if (!box) { console.warn('[ai-runner] rotate: 未找到输入框'); return }
      fillInput(box, instruction)
      setTimeout(doSend, 300, box)
      return
    }

    if (d.type === 'ai-runner:new-session') {
      // [no-summary-v1] 不再搬运 summary；仅切换会话并回执
      const clicked = clickNewSession()
      if (clicked) {
        setTimeout(() => {
          post({ type: 'ai-runner:new-session-created', url: location.href, id: extractId(), sessionId: extractSidFromHash() })
        }, 1500)
      } else {
        post({ type: 'ai-runner:new-session-created', url: '', id: '', degraded: true, sessionId: extractSidFromHash() })
      }
      return
    }

    if (d.type === 'ai-runner:request-replay') {
      // [replay] 工作台刷新后请求重发最近消息
      try {
        for (const m of _msgBuf) {
          if (m && (m.type === 'ai-runner:reply' || m.type === 'ai-runner:session-id')) {
            if (window.opener && !window.opener.closed) window.opener.postMessage(m, '*')
          }
        }
      } catch { /* ignore */ }
      return
    }

    if (d.type === 'ai-runner:request-rescan') {
      // [rescan] 重扫 DOM：即便油猴缓存丢失，也从页面重新抓取最新回复
      try {
        const s2 = extractLatestScript()
        if (s2 && s2.code) {
          window.opener && window.opener.postMessage({
            type: 'ai-runner:reply',
            kind: 'script',
            code: s2.code,
            lang: s2.lang,
            hash: s2.hash,
            site: location.origin,
            sessionId: extractSidFromHash(),
            rescan: true,
          }, '*')
        } else {
          const txt = extractLatestReplyText()
          if (txt && txt.length > 20) {
            window.opener && window.opener.postMessage({
              type: 'ai-runner:reply',
              kind: 'plain',
              text: txt,
              sessionId: extractSidFromHash(),
              rescan: true,
            }, '*')
          }
        }
        window.opener && window.opener.postMessage({ type: 'ai-runner:session-id', id: extractId(), sessionId: extractSidFromHash() }, '*')
      } catch { /* ignore */ }
      return
    }
    if (d.type === 'ai-runner:stop') {
      // [stop-v2] 清缓冲 + 保留去重集 + disconnect
      // [WHY] replyObserver 常驻 body；清空 seenHashes/lastBodySig 会让旧回复被重判为新回复 post
      // [CONSTRAINT] 保留 seenHashes / seenDoneMarkers / lastBodySig；下次 fill/rotate 由 resumeReplyObserver 恢复
      // [CHANGE-IMPACT] 与 resumeReplyObserver 成对；改此处必须同步改 resume 触发点
      const stopHit = clickStopGenerating()
      console.log('[ai-runner] stop received, stop-btn hit =', stopHit)
      _msgBuf.length = 0
      _pending.length = 0
      if (observerDebounce) { clearTimeout(observerDebounce); observerDebounce = null }
      try { replyObserver.disconnect() } catch { /* ignore */ }
      _replyObserving = false
    }
  })
})()
