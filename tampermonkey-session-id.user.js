// ==UserScript==
// @name         AI Runner · 会话 ID + token 估算回传
// @namespace    ai-runner
// @version      1.1.0
// @description  把当前 AI 对话页的会话 ID 和估算 token 量回传给 AI Runner
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
})()
