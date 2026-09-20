// ==UserScript==
// @name         AI Runner · 会话 ID + token 估算 + 回复回传 + fill 接收
// @namespace    ai-runner
// @version      1.4.1
// @description  回传会话 ID/token/AI 回复到工作台；接收 fill/stop（修复千问 Slate 输入框）
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
    { re: /qianwen\.aliyun\.com\/[\w-]*\/?([\w-]{20,})/, n: 1 }
  ]

  const RATIO_CJK = 0.6
  const RATIO_LATIN = 0.25

  let lastId = ''
  let lastSid = ''
  let lastTokens = -1

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

  const TEXT_SELECTORS = [
    '[class*="message"]',
    '[class*="chat-message"]',
    '[class*="markdown"]',
    '[data-message-author-role]',
    '.ds-markdown',
    '.markdown',
    '.chat-answers-card-wrap',
    '.chat-question-card-wrap',
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
    const sid = extractSidFromHash()
    const tokens = estimateTokens(collectText())
    let changed = false
    if (id && id !== lastId) { lastId = id; changed = true }
    if (sid !== lastSid) { lastSid = sid; changed = true }
    if (tokens !== lastTokens && tokens > 0) { lastTokens = tokens; changed = true }
    if (!changed) return
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage({ type: 'ai-runner:session-id', id, sessionId: extractSidFromHash() }, '*')
        if (tokens > 0) {
          window.opener.postMessage({ type: 'ai-runner:token-estimate', tokens, sessionId: extractSidFromHash() }, '*')
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

  let domTimer = null
  const observer = new MutationObserver(() => {
    if (domTimer) clearTimeout(domTimer)
    domTimer = setTimeout(send, 800)
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })

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
    if (/^(bash|sh|shell|zsh)\b/.test(t)) return 'bash'
    if (/^(js|javascript|cjs|commonjs|node|nodejs)\b/.test(t)) return 'js'
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
    if (/\bprocess\.(exit|argv|env)\b/.test(head)) return 'js'
    if (/^\s*(echo|cd\s|ls\s|mkdir|git\s|pnpm\s|npm\s|yarn\s|rm\s)/m.test(head)) return 'bash'
    if (/\bif\s+\[\s/.test(head) || /\bfi\b/.test(head) || /\$\(/.test(head)) return 'bash'
    return null
  }
  function extractLatestScript() {
    const pres = document.querySelectorAll('pre')
    let last = null
    let lastMarked = null
    for (const pre of pres) {
      const text = (pre.textContent || '').replace(/^\n+|\n+$/g, '')
      if (!text) continue
      if (!text.includes('\n') && text.length < 120) continue
      const lang = guessLangFromDom(pre) || guessLangFromContent(text) || null
      if (lang !== 'cjs' && lang !== 'js' && lang !== 'bash') continue
      const item = { lang, code: text, hash: hash32(text) }
      last = item
      const marked = /^#!\s*\/usr\/bin\/env\s+(node|bash)\b/m.test(text)
        || /^\s*\/\/\s*@desc\s*:/m.test(text)
        || /^\s*#\s*@desc\s*:/m.test(text)
      if (marked) lastMarked = item
    }
    return lastMarked || last
  }

  function findNewDone() {
    const nodes = document.querySelectorAll('div,p,span,li')
    let found = null
    for (const el of nodes) {
      if (el.children.length > 0) continue
      const t = (el.textContent || '').trim()
      if (!/^\s*DONE\s*$/.test(t)) continue
      const marker = hash32(`${t}|${(el.outerHTML || '').slice(0, 120)}`)
      if (seenDoneMarkers.has(marker)) continue
      found = marker
    }
    return found
  }

  function bodySignature() {
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
        if (handoffMode === 'waiting-summary') {
          const replyText = extractLatestReplyText()
          if (replyText && replyText.length > 30 && replyText === handoffReplyText) {
            handoffMode = 'off'
            handoffReplyText = ''
            window.opener.postMessage({ type: 'ai-runner:summary', text: replyText, aiSiteId: extractId(), sessionId: extractSidFromHash(), degraded: false }, '*')
          } else if (replyText && replyText.length > 30) {
            handoffReplyText = replyText
          }
          return
        }
        const s = extractLatestScript()
        if (s && !seenHashes.has(s.hash)) {
          seenHashes.add(s.hash)
          window.opener.postMessage({
            type: 'ai-runner:reply',
            kind: 'script',
            code: s.code,
            lang: s.lang,
            hash: s.hash,
            site: location.origin,
            sessionId: extractSidFromHash(),
          }, '*')
          lastBodySig = bodySignature()
          return
        }
        const doneMarker = findNewDone()
        if (doneMarker) {
          seenDoneMarkers.add(doneMarker)
          window.opener.postMessage({
            type: 'ai-runner:reply',
            kind: 'done',
            site: location.origin,
            sessionId: extractSidFromHash(),
          }, '*')
          lastBodySig = bodySignature()
          return
        }
        const sig = bodySignature()
        if (sig !== lastBodySig) {
          lastBodySig = sig
          window.opener.postMessage({
            type: 'ai-runner:reply',
            kind: 'plain',
            site: location.origin,
            sessionId: extractSidFromHash(),
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

  // ===== fill / rotate / new-session / stop =====
  function clickStopGenerating() {
    try {
      const all = Array.from(document.querySelectorAll('button'))
      const btn = all.find((b) => {
        const lbl = `${b.getAttribute('aria-label') || ''} ${b.textContent || ''} ${b.getAttribute('title') || ''}`
        return /停止生成|停止回答|停止输出|stop\s*generat|stop\s*stream|stop\s*response|stop\s*answer/i.test(lbl)
      })
      if (btn && !btn.disabled) {
        btn.click()
        return true
      }
    } catch (e) {}
    return false
  }

  let handoffMode = 'off'
  let handoffReplyText = ''

  function findNewChatButton() {
    const all = Array.from(document.querySelectorAll('button, a'))
    return all.find((el) => {
      const lbl = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''} ${el.getAttribute('title') || ''}`
      return /新建对话|新对话|新建聊天|new\s*chat|new\s*conversation/i.test(lbl)
    }) || null
  }
  function clickNewSession() {
    const btn = findNewChatButton()
    if (btn && !btn.disabled) {
      try { btn.click(); return true } catch {}
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
      } catch (e) {}

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
        try { Object.defineProperty(ev, 'clipboardData', { value: dt }) } catch (e) {}
        box.dispatchEvent(ev)
        pasted = (box.innerText || '').trim().length > 0
      } catch (e) {}

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
        } catch (e) {}
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
      const stillHas = (box.innerText || box.value || '').trim().length > 0
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
      const prompt = String(d.prompt || '')
      if (!prompt) return
      const box = findInputBox()
      if (!box) { console.warn('[ai-runner] 未找到输入框'); return }
      fillInput(box, prompt)
      setTimeout(doSend, 300, box)
      return
    }

    if (d.type === 'ai-runner:rotate') {
      const instruction = String(d.instruction || '')
      if (!instruction) return
      const box = findInputBox()
      if (!box) { console.warn('[ai-runner] rotate: 未找到输入框'); return }
      handoffReplyText = ''
      handoffMode = 'waiting-summary'
      fillInput(box, instruction)
      setTimeout(doSend, 300, box)
      return
    }

    if (d.type === 'ai-runner:new-session') {
      const summary = String(d.summary || '')
      const clicked = clickNewSession()
      if (clicked) {
        setTimeout(() => {
          const box = findInputBox()
          if (!box) {
            window.opener.postMessage({ type: 'ai-runner:new-session-created', url: location.href, id: extractId(), sessionId: extractSidFromHash() }, '*')
            return
          }
          const prefix = '这是上一个会话的上下文总结，请基于此继续工作：\n'
          fillInput(box, prefix + summary)
          setTimeout(doSend, 300, box)
          window.opener.postMessage({ type: 'ai-runner:new-session-created', url: location.href, id: extractId(), sessionId: extractSidFromHash() }, '*')
        }, 1500)
      } else {
        window.opener.postMessage({ type: 'ai-runner:new-session-created', url: '', id: '', degraded: true, sessionId: extractSidFromHash() }, '*')
      }
      return
    }

    if (d.type === 'ai-runner:stop') {
      clickStopGenerating()
      seenHashes.clear()
      seenDoneMarkers.clear()
      lastBodySig = ''
      handoffMode = 'off'
      handoffReplyText = ''
      if (replyDebounce) { clearTimeout(replyDebounce); replyDebounce = null }
    }
  })
})()
