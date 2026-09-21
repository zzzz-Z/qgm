/* eslint-disable ts/ban-ts-comment -- 需禁用整文件类型检查 */
// @ts-nocheck

// 浏览器上下文 DOM 逻辑：这些函数通过 page.evaluate 序列化后传入浏览器执行。
// Node 侧 tsconfig 无 DOM lib，故此文件豁免类型检查（函数体运行环境有完整 DOM）。
// 从 scripts/tampermonkey-session-id.user.js 移植（findInputBox / fillInput / findSendButton / sendEnter / clickStopGenerating / clickNewSession）。
// 约束：纯函数、无外部闭包引用 —— 序列化后代码结构必须完整。

export function fillPromptInPage(args) {
  const prompt = String((args && args.prompt) || '')
  if (!prompt) return false
  const input = document.querySelector('textarea:not([readonly]):not([disabled])')
    || document.querySelector('[contenteditable="true"]')
  if (!input) return false
  if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
    const proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set
    if (setter) setter.call(input, prompt)
    else input.value = prompt
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  } else if (input.isContentEditable) {
    input.focus()
    document.execCommand('insertText', false, prompt)
  } else {
    return false
  }
  const all = Array.from(document.querySelectorAll('button:not([disabled])'))
  const sendBtn = all.find((b) => {
    const lbl = `${b.getAttribute('aria-label') || ''} ${b.textContent || ''}`
    return /发送|send|submit/i.test(lbl)
  })
  if (sendBtn) {
    sendBtn.click()
    return true
  }
  const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }
  input.dispatchEvent(new KeyboardEvent('keydown', opts))
  input.dispatchEvent(new KeyboardEvent('keypress', opts))
  input.dispatchEvent(new KeyboardEvent('keyup', opts))
  return true
}

export function stopGeneratingInPage() {
  const all = Array.from(document.querySelectorAll('button'))
  const btn = all.find((b) => {
    const lbl = `${b.getAttribute('aria-label') || ''} ${b.textContent || ''} ${b.getAttribute('title') || ''}`
    return /停止生成|停止回答|停止输出|stop\s*generat|stop\s*stream|stop\s*response|stop\s*answer/i.test(lbl)
  })
  if (btn && !btn.disabled) {
    btn.click()
    return true
  }
  return false
}

export function clickNewSessionInPage() {
  const all = Array.from(document.querySelectorAll('button, a'))
  const btn = all.find((el) => {
    const lbl = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''} ${el.getAttribute('title') || ''}`
    return /新建对话|新对话|新建聊天|new\s*chat|new\s*conversation/i.test(lbl)
  })
  if (btn) {
    btn.click()
    return true
  }
  return false
}

// ============================================================================
// 回复检测 —— 页面内轮询，替代油猴 MutationObserver
// dedup state 存 window.__aiRunnerDedup（跨 poll 持久）：
//   seenHashes: string[]      已回传过的代码块 hash
//   seenDoneMarkers: string[] 已回传过的 DONE 标记
//   lastBodySig: string       上次正文签名
// 返回 null 表示无变化；否则返回分类结果：
//   { kind: 'script', code, lang, hash }
//   { kind: 'done', text }
//   { kind: 'plain' }
// ============================================================================

export function detectReplyInPage() {
  const w = window
  if (!w.__aiRunnerDedup) {
    w.__aiRunnerDedup = { seenHashes: [], seenDoneMarkers: [], lastBodySig: '', _pendingScriptHash: null, _plainSentInCycle: false } // [fix-reply-dedup] [fix-plain-once]
  }
  const dedup = w.__aiRunnerDedup
  // body version + hash 缓存，避免每次 poll 重算
  if (typeof dedup._bodyVersion !== 'number') dedup._bodyVersion = 0
  if (!dedup._sigCache) dedup._sigCache = { version: -1, sig: '' }
  if (!dedup._preCache) dedup._preCache = new WeakMap()
  if (typeof dedup._seenGrowth !== 'boolean') dedup._seenGrowth = false
  if (typeof dedup._stableCount !== 'number') dedup._stableCount = 0
  if (!dedup._observerInstalled) {
    dedup._observerInstalled = true
    try {
      const obs = new MutationObserver(() => { dedup._bodyVersion++ })
      obs.observe(document.body, { childList: true, subtree: true, characterData: true })
      dedup._observer = obs
    } catch {}
  }

  function hash32(s) {
    let h = 0x811C9DC5
    for (let i = 0; i < s.length; i++) {
      h = Math.imul(h ^ s.charCodeAt(i), 0x1000193) >>> 0
    }
    return (h >>> 0).toString(16).padStart(8, '0')
  }

  function langFromText(s) {
    const t = String(s || '').trim().toLowerCase()
    if (!t || t.length > 24) return null
    if (/^(?:bash|sh|shell|zsh)\b/.test(t)) return 'bash'
    if (/^(?:js|javascript|cjs|commonjs|node|nodejs)\b/.test(t)) return 'js'
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
    if (/^\s*(?:echo|cd\s|ls\s|mkdir|git\s|pnpm\s|npm\s|yarn\s|rm\s)/m.test(head)) return 'bash'
    if (/\bif\s+\[\s/.test(head) || /\bfi\b/.test(head) || /\$\(/.test(head)) return 'bash'
    return null
  }

  function extractLatestScript() {
    // 只扫最后一条 assistant 消息，排除历史/用户消息
    const blocks = document.querySelectorAll('.ds-assistant-message-main-content')
    const root = blocks.length > 0 ? blocks[blocks.length - 1] : document
    const pres = root.querySelectorAll('pre')
    let last = null
    let lastMarked = null
    for (const pre of pres) {
      const text = (pre.textContent || '').replace(/^\n+|\n+$/g, '')
      if (!text) continue
      if (!text.includes('\n') && text.length < 120) continue
      const lang = guessLangFromDom(pre) || guessLangFromContent(text) || null
      if (lang !== 'js' && lang !== 'bash') continue
      let _h
      const _cached = dedup._preCache.get(pre)
      if (_cached && _cached.len === text.length) { _h = _cached.hash }
      else { _h = hash32(text); dedup._preCache.set(pre, { len: text.length, hash: _h }) }
      const item = { lang, code: text, hash: _h }
      last = item
      const marked = /^#!\s*\/usr\/bin\/env\s+(?:node|bash)\b/m.test(text)
        || /^\s*\/\/\s*@desc\s*:/m.test(text)
        || /^\s*#\s*@desc\s*:/m.test(text)
      if (marked) lastMarked = item
    }
    return lastMarked || last
  }

  // 取当前页面主文本（AI 回复区）
  function getMainText() {
    // 只取最后一条 assistant 消息的文本
    const blocks = document.querySelectorAll('.ds-assistant-message-main-content')
    if (blocks.length === 0) return ''
    const el = blocks[blocks.length - 1]
    const t = (el && el.textContent) || ''
    return t.slice(-8000)
  }
  function findNewDone() {
    // 只扫最后一条 assistant 消息
    const blocks = document.querySelectorAll('.ds-assistant-message-main-content')
    const root = blocks.length > 0 ? blocks[blocks.length - 1] : document
    const nodes = root.querySelectorAll('div,p,span,li')
    let found = null
    for (const el of nodes) {
      if (el.children.length > 0) continue
      const t = (el.textContent || '').trim()
      if (!/^\s*DONE\s*$/.test(t)) continue
      const marker = hash32(`${t}|${(el.outerHTML || '').slice(0, 120)}`)
      if (dedup.seenDoneMarkers.includes(marker)) continue
      found = { marker, text: String(root.textContent || '').trim() } // [done-with-summary]
    }
    return found
  }

  function bodySignature() {
    const cache = dedup._sigCache
    if (cache.version === dedup._bodyVersion && cache.sig) return cache.sig
    const t = (document.body.textContent || '').replace(/\s+/g, ' ')
    const s = hash32(t.slice(-300))
    cache.version = dedup._bodyVersion
    cache.sig = s
    return s
  }

  // script 需连续 2 次相同 hash 才推，避开流式中途残缺
  const script = extractLatestScript()
  if (script && !dedup.seenHashes.includes(script.hash)) {
    if (dedup._pendingScriptHash === script.hash) {
      dedup._pendingScriptHash = null
      dedup.seenHashes.push(script.hash)
      dedup.lastBodySig = bodySignature()
      return { kind: 'script', code: script.code, lang: script.lang, hash: script.hash }
    }
    dedup._pendingScriptHash = script.hash
    return null
  }

  const doneMarker = findNewDone()
  if (doneMarker) {
    dedup.seenDoneMarkers.push(doneMarker.marker)
    dedup.lastBodySig = bodySignature()
    return { kind: 'done', text: doneMarker.text }
  }

  // 文本稳定检测：连续 3 次 body 不变 → 生成结束，推 plain + text
  const sig2 = bodySignature()
  if (sig2 !== dedup.lastBodySig) {
    dedup.lastBodySig = sig2
    dedup._stableCount = 0
    dedup._seenGrowth = true
    return null
  }
  if (!dedup._seenGrowth) return null
  if (dedup._plainSentInCycle) return null
  dedup._stableCount = (dedup._stableCount || 0) + 1
  if (dedup._stableCount < 3) return null
  dedup._plainSentInCycle = true
  return { kind: 'plain', text: getMainText() }

  return null
}

/** 重置 dedup state（fill 点发送后调用，避免旧代码块/用户消息误判） */
export function resetReplyDedupInPage() {
  // 初始 lastBodySig 设为当前页面 sig，防止第一次 poll 因 sig != '' 误推 plain
  const el = document.querySelector('main') || document.body
  const t = ((el && el.textContent) || '').replace(/\s+/g, ' ')
  const s = t.slice(-300)
  let h = 0x811C9DC5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x1000193) >>> 0
  const sig = (h >>> 0).toString(16).padStart(8, '0')
  window.__aiRunnerDedup = { seenHashes: [], seenDoneMarkers: [], lastBodySig: sig, _pendingScriptHash: null, _plainSentInCycle: false, _stableCount: 0, _seenGrowth: false }
  return true
}

/** 收集页面主文本（尾部 8k 字符），用于 token 估算。 */
export function collectTextInPage() {
  const el = document.querySelector('main') || document.body
  const t = (el && el.textContent) || ''
  return t.slice(-8000)
}

/** 粗估 token：CJK ~1.5 chars/token，其余 ~4 chars/token。 */
export function estimateTokensInPage(text) {
  if (!text) return 0
  let cjk = 0; let other = 0
  for (const ch of String(text)) {
    const c = ch.codePointAt(0) || 0
    if ((c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3040 && c <= 0x30FF) || (c >= 0xAC00 && c <= 0xD7AF)) cjk++
    else other++
  }
  return Math.ceil(cjk / 1.5 + other / 4)
}
