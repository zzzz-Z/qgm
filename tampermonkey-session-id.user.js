// ==UserScript==
// @name         AI Runner · 会话 ID + token 估算 + 回复回传 + fill 接收
// @namespace    ai-runner
// @version      1.3.0
// @description  回传会话 ID/token/AI 回复（script/done/plain/multi）到工作台；接收 fill/stop
// @match        https://chat.deepseek.com/*
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @match        https://claude.ai/*
// @match        https://kimi.moonshot.cn/*
// @match        https://gemini.google.com/*
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
  ]

  // 估算系数（token / 字符）
  const RATIO_CJK = 0.6
  const RATIO_LATIN = 0.25

  let lastId = ''
  let lastTokens = -1

  function extractId() {
    const href = location.href
    for (let i = 0; i < RULES.length; i++) {
      const m = href.match(RULES[i].re)
      if (m) return decodeURIComponent(m[RULES[i].n])
    }
    return ''
  }

  // 从 DOM 抽对话文本。选择器覆盖 DeepSeek / ChatGPT / Claude / Kimi / Gemini
  const TEXT_SELECTORS = [
    '[class*="message"]',
    '[class*="chat-message"]',
    '[class*="markdown"]',
    '[data-message-author-role]',
    '.ds-markdown',
    '.markdown',
  ]

  function collectText() {
    const seen = new Set()
    const parts = []
    for (let i = 0; i < TEXT_SELECTORS.length; i++) {
      const nodes = document.querySelectorAll(TEXT_SELECTORS[i])
      for (let j = 0; j < nodes.length; j++) {
        const el = nodes[j]
        if (seen.has(el)) continue
        seen.add(el)
        // 跳过嵌套，只取最外层容器
        let parent = el.parentElement
        let skip = false
        while (parent) {
          if (seen.has(parent)) { skip = true; break }
          parent = parent.parentElement
        }
        if (skip) continue
        const t = el.innerText || el.textContent || ''
        if (t) parts.push(t)
      }
    }
    return parts.join('\n')
  }

  function estimateTokens(text) {
    if (!text) return 0
    let cjk = 0
    let latin = 0
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)
      // CJK 统一表意文字 + 全角标点
      if ((code >= 0x4E00 && code <= 0x9FFF)
        || (code >= 0x3000 && code <= 0x303F)
        || (code >= 0xFF00 && code <= 0xFFEF)) {
        cjk++
      } else {
        latin++
      }
    }
    return Math.round(cjk * RATIO_CJK + latin * RATIO_LATIN)
  }

  function send() {
    const id = extractId()
    const tokens = estimateTokens(collectText())
    let changed = false
    if (id && id !== lastId) { lastId = id; changed = true }
    if (tokens !== lastTokens && tokens > 0) { lastTokens = tokens; changed = true }
    if (!changed) return
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage({ type: 'ai-runner:session-id', id }, '*')
        if (tokens > 0) {
          window.opener.postMessage({ type: 'ai-runner:token-estimate', tokens }, '*')
        }
      }
    } catch (e) {}
  }

  send()

  let lastHref = location.href
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href
      send()
    }
  }, 500)

  // DOM 变化后重新估算（防抖 800ms）
  let domTimer = null
  const observer = new MutationObserver(() => {
    if (domTimer) clearTimeout(domTimer)
    domTimer = setTimeout(send, 800)
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })

  window.addEventListener('popstate', send)
  window.addEventListener('hashchange', send)

  // ===========================================================================
  // AI 回复回传（v6 §3.1 ai-runner:reply）—— 2s 静默 + 严格分类
  // 四类（v6 §6 状态机输入）：
  //   script —— 恰好 1 个「新」cjs/bash 代码块
  //   multi  —— 出现 ≥2 个新代码块（契约违规）
  //   done   —— 严格匹配 ^\s*DONE\s*$ 的独立元素（v6 §6.9 第 1 条）
  //   plain  —— 无新代码块、无 DONE，但正文发生变化（纯文本回复）
  // 去重：已回传 hash 的代码块 / 已见过的 DONE 元素 / 正文签名 不再重复回传
  // ===========================================================================

  /** FNV-1a 32 位变种，截 8 hex 位（与工作台 useScriptInbox 完全一致） */
  function hash32(s) {
    let h = 0x811c9dc5
    for (let i = 0; i < s.length; i++) {
      h = Math.imul(h ^ s.charCodeAt(i), 0x1000193) >>> 0
    }
    return (h >>> 0).toString(16).padStart(8, '0')
  }

  const seenHashes = new Set()
  const seenDoneMarkers = new Set()
  let lastBodySig = ''

  /** 扫描页面所有「新」cjs/bash 代码块（按 DOM 顺序） */
    function langFromText(s) {
    const t = String(s || '').trim().toLowerCase()
    if (!t || t.length > 24) return null
    if (/^(bash|sh|shell|zsh)\b/.test(t)) return 'bash'
    if (/^(cjs|commonjs|node|nodejs)\b/.test(t)) return 'cjs'
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
    if (/^#!\s*\/usr\/bin\/env\s+node/.test(head)) return 'cjs'
    if (/\brequire\s*\(/.test(head)) return 'cjs'
    if (/\bmodule\.exports\b/.test(head)) return 'cjs'
    if (/\bprocess\.(exit|argv|env)\b/.test(head)) return 'cjs'
    if (/^\s*(echo|cd\s|ls\s|mkdir|git\s|pnpm\s|npm\s|yarn\s|rm\s)/m.test(head)) return 'bash'
    if (/\bif\s+\[\s/.test(head) || /\bfi\b/.test(head) || /\$\(/.test(head)) return 'bash'
    return null
  }
  function scanNewBlocks() {
    const out = []
    const pres = document.querySelectorAll('pre')
    for (const pre of pres) {
      const text = (pre.textContent || '').replace(/^\n+|\n+$/g, '')
      if (!text) continue
      if (!text.includes('\n') && text.length < 120) continue
      const lang = guessLangFromDom(pre) || guessLangFromContent(text) || null
      if (lang !== 'cjs' && lang !== 'bash') continue
      const hash = hash32(text)
      if (seenHashes.has(hash)) continue
      out.push({ lang, code: text, hash })
    }
    return out
  }

  /** 找严格 DONE：独立元素文本 trim 后恰为 DONE（防止「this task is done」误判） */
  function findNewDone() {
    // 限制候选：叶子级小元素，避免大容器 textContent 恰好为 DONE 的极端情况
    const nodes = document.querySelectorAll('div,p,span,li')
    let found = null
    for (const el of nodes) {
      if (el.children.length > 0) continue
      const t = (el.textContent || '').trim()
      if (!/^\s*DONE\s*$/.test(t)) continue
      const marker = hash32(t + '|' + (el.outerHTML || '').slice(0, 120))
      if (seenDoneMarkers.has(marker)) continue
      found = marker
    }
    return found
  }

  function bodySignature() {
    // 取页面正文尾部 300 字符做签名，足以检测「新一轮纯文本回复」
    const t = (document.body.innerText || '').replace(/\s+/g, ' ')
    return hash32(t.slice(-300))
  }

  let replyDebounce = null
  function classifyAndPost() {
    if (replyDebounce) clearTimeout(replyDebounce)
    replyDebounce = setTimeout(() => {
      replyDebounce = null
      try {
        if (!window.opener || window.opener.closed) return
        const fresh = scanNewBlocks()
        const doneMarker = findNewDone()
        if (fresh.length === 1) {
          const s = fresh[0]
          seenHashes.add(s.hash)
          window.opener.postMessage({
            type: 'ai-runner:reply', kind: 'script',
            code: s.code, lang: s.lang, hash: s.hash, site: location.origin,
          }, '*')
          lastBodySig = bodySignature()
          return
        }
        if (fresh.length > 1) {
          fresh.forEach(s => seenHashes.add(s.hash))
          window.opener.postMessage({
            type: 'ai-runner:reply', kind: 'multi', count: fresh.length, site: location.origin,
          }, '*')
          lastBodySig = bodySignature()
          return
        }
        if (doneMarker) {
          seenDoneMarkers.add(doneMarker)
          window.opener.postMessage({
            type: 'ai-runner:reply', kind: 'done', site: location.origin,
          }, '*')
          lastBodySig = bodySignature()
          return
        }
        // 纯文本：正文签名变化才回传（避免 token 浮层等噪声反复触发）
        const sig = bodySignature()
        if (sig !== lastBodySig) {
          lastBodySig = sig
          window.opener.postMessage({
            type: 'ai-runner:reply', kind: 'plain', site: location.origin,
          }, '*')
        }
      } catch {}
    }, 2000)
  }

  const replyObserver = new MutationObserver(() => {
    if (replyDebounce) clearTimeout(replyDebounce)
    replyDebounce = setTimeout(classifyAndPost, 0)
  })
  replyObserver.observe(document.body, { childList: true, subtree: true, characterData: true })

  // ===========================================================================
  // fill 接收（v6 §3.1 ai-runner:fill）—— 工作台向 AI 站点窗口发 prompt，自动填入并发送
  // 算法（通用、多站点 best-effort）：
  //   1. 找输入框（textarea 优先，否则 contenteditable）
  //   2. 写入 prompt + 触发 input 事件（让 React/Vue 之类的受控组件识别）
  //   3. 找发送按钮（aria-label 含「发送/send」或紧邻输入框的 button[type=submit]）
  //   4. 找不到按钮 → 不自动发送，让用户手按 Enter（保留人类在环）
  // 信任模型：postMessage 来源不严格校验 origin（跨域读 opener.origin 受限），
  //   但只触发「在 AI 聊天框输入文本」这一低危操作
  // ===========================================================================

  function findInputBox() {
    // DeepSeek 用 textarea；ChatGPT/Claude 也都是 textarea；contenteditable 作为兜底
    const ta = document.querySelector('textarea:not([readonly]):not([disabled])')
    if (ta) return ta
    const ce = document.querySelector('[contenteditable="true"]')
    return ce || null
  }

  function findSendButton(input) {
    // 1. aria-label 含「发送」或 send
    const all = Array.from(document.querySelectorAll('button:not([disabled])'))
    const byAria = all.find(b => {
      const lbl = (b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')
      return /发送|send|submit|发送消息/i.test(lbl)
    })
    if (byAria) return byAria
    // 2. 紧邻 input 的 button[type=submit]
    if (input && input.form) {
      const sb = input.form.querySelector('button[type=submit]:not([disabled])')
      if (sb) return sb
    }
    // 3. 输入框父级的下一个 button
    if (input) {
      let p = input.parentElement
      for (let i = 0; i < 5 && p; i++, p = p.parentElement) {
        const sb = p.querySelector('button:not([disabled])')
        if (sb) return sb
      }
    }
    return null
  }

  function fillInput(box, text) {
    if (box.tagName === 'TEXTAREA' || box.tagName === 'INPUT') {
      // 受控组件：用原生 setter + dispatch input event
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
        || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      if (setter) setter.call(box, text)
      else box.value = text
      box.dispatchEvent(new Event('input', { bubbles: true }))
      box.dispatchEvent(new Event('change', { bubbles: true }))
    } else if (box.isContentEditable) {
      box.focus()
      document.execCommand('insertText', false, text)
    }
  }

  window.addEventListener('message', (e) => {
    const d = e.data
    if (!d || typeof d !== 'object') return
    if (d.type === 'ai-runner:fill') {
      const prompt = String(d.prompt || '')
      if (!prompt) return
      const box = findInputBox()
      if (!box) {
        console.warn('[ai-runner] 未找到输入框，无法 fill')
        return
      }
      fillInput(box, prompt)
      // 短延迟后尝试点发送
      setTimeout(() => {
        const btn = findSendButton(box)
        if (btn) btn.click()
        else console.warn('[ai-runner] 未找到发送按钮，请手按 Enter')
      }, 100)
      return
    }
    if (d.type === 'ai-runner:stop') {
      // 清空回复检测状态：新循环开始前，旧代码块/DONE/正文签名全部重新计为「新」
      seenHashes.clear()
      seenDoneMarkers.clear()
      lastBodySig = ''
      if (replyDebounce) { clearTimeout(replyDebounce); replyDebounce = null }
      return
    }
  })
})()
