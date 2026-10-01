/* eslint-disable ts/ban-ts-comment -- 需禁用整文件类型检查 */
// @ts-nocheck

// 浏览器上下文 DOM 逻辑：这些函数通过 page.evaluate 序列化后传入浏览器执行。
// Node 侧 tsconfig 无 DOM lib，故此文件豁免类型检查（函数体运行环境有完整 DOM）。
// 从 scripts/tampermonkey-session-id.user.js 移植（findInputBox / fillInput / findSendButton / sendEnter / clickStopGenerating / clickNewSession）。
// 约束：纯函数、无外部闭包引用 —— 序列化后代码结构必须完整。

/**
 * 在页面上下文内填充提示词到输入框（Playwright evaluate 目标函数）
 * [WHY] 必须走页面的原生 setter 并派发 input 事件，否则 React/Vue 双向绑定监听不到值变化
 * [CONSTRAINT] 优先 textarea 再 contenteditable；未找到输入框或 prompt 为空返回 false
 * [CHANGE-IMPACT] 返回值被 headless 池的 fillPrompt 判定为成功标志；改判定会让上游误认为已发送
 * @param args Playwright evaluate 传入的 { prompt } 参数对象
 */
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

/**
 * 停止 Generating In Page
 */
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

/**
 * 执行 click New Session In Page
 */
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

/**
 * 检测 Reply In Page
 */
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
    } catch { /* swallow: document.body 未就绪 / Observer 不支持，dedup 退化为纯计数 */ }
  }

  function hash32(input) {
    let h = 0x811C9DC5
    for (let i = 0; i < input.length; i++) {
      h = Math.imul(h ^ input.charCodeAt(i), 0x1000193) >>> 0
    }
    return (h >>> 0).toString(16).padStart(8, '0')
  }

  function langFromText(text) {
    const t = String(text || '').trim().toLowerCase()
    if (!t || t.length > 24) return null
    if (/^(?:bash|sh|shell|zsh)\b/.test(t)) return 'bash'
    if (/^(?:js|javascript|cjs|commonjs|node|nodejs)\b/.test(t)) return 'js'
    return null
  }

  // [code-text-clean-v1] 从 <code class="language-xxx"> 直接判语言
  // [WHY] DeepSeek 代码块头的语言标签/复制按钮不进入 <code> 元素，取 className 比邻近 DOM 探测更可靠
  // [CONSTRAINT] 只认 js/bash 两种（与 extractLatestScript 白名单一致），其余返回 null 交给后续探测
  // [CHANGE-IMPACT] 与 guessLangFromDom / guessLangFromContent 组成三级回退，改单级不影响其他级；
  //                与 scripts/tampermonkey-session-id.user.js 同名函数保持同步，避免双通道行为分叉
  function guessLangFromClass(el: Element | null): string | null {
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
    if (/^\s*(?:echo|cd\s|ls\s|mkdir|git\s|pnpm\s|npm\s|yarn\s|rm\s)/m.test(head)) return 'bash'
    if (/\bif\s+\[\s/.test(head) || /\bfi\b/.test(head) || /\$\(/.test(head)) return 'bash'
    return null
  }

  /** 检测文本是否含 js 代码块（接收端容错） */
  function hasJsFence(text: string): boolean {
    // [hasjsfence-dom-v1] DOM 优先检测 <pre><code>：getMainText() 返回 DOM textContent（不含 markdown 反引号），
    //   原字面量正则 ```js 在 textContent 上永远 false → plain 兜底分支 line 380 从不成立 → 前端静默收不到回复
    // [CONSTRAINT] 只看最后一条 assistant 消息；本文件经 page.evaluate 序列化执行，禁止引用外部闭包变量
    // [CHANGE-IMPACT] 影响 line 380 的 plain 推送决策：修复后含任意代码块的回复会推 plain（原意为过滤纯问候语）
    const blocks = document.querySelectorAll('.ds-assistant-message-main-content')
    const root = blocks.length > 0 ? blocks[blocks.length - 1] : document
    if (root.querySelectorAll('pre code').length > 0) return true
    return /```js\b/.test(String(text || ''))
  }

  // [ask-in-plain-v1] 交互提问豁免：纯 Markdown 无围栏同样需推送
  // [WHY] hasJsFence 门槛是为过滤纯问候语，但以指定前缀开头的文本是需用户响应的正式指令，必须放行
  // [CONSTRAINT] 只匹配首个非空行的前缀（词边界）；与 utils/ask-parser.ts 对齐
  function isAskPrefix(text: string): boolean {
    const s = String(text || '')
    const firstLine = s.split(/\r?\n/).find(l => l.trim().length > 0) || ''
    return /^\s*@ask\b/i.test(firstLine)
  }

  function extractLatestScript() {
    // 只扫最后一条 assistant 消息，排除历史/用户消息
    const blocks = document.querySelectorAll('.ds-assistant-message-main-content')
    const root = blocks.length > 0 ? blocks[blocks.length - 1] : document
    const pres = root.querySelectorAll('pre')
    let last = null
    let lastMarked = null
    for (const pre of pres) {
      // [code-text-clean-v1] 优先从 <pre><code> 取文本，避开代码块头的语言标签与「复制/下载」按钮文字
      // [WHY] pre.textContent 会把头部按钮文字并入首行，污染后 #! 锚点失配、语言判定失败导致整块跳过
      // [CONSTRAINT] 无 code 子元素时回退 pre 本身；text 变量名保持，后续 hash/done 提取均复用同一字符串
      const codeEl = pre.querySelector('code') || pre
      const text = (codeEl.textContent || '').replace(/^\n+|\n+$/g, '')
      if (!text) continue
      if (!text.includes('\n') && text.length < 120) continue
      // [code-text-clean-v1] 语言判定三级回退：className → DOM 邻近探测 → 内容特征
      let lang = guessLangFromClass(codeEl) || guessLangFromDom(pre) || guessLangFromContent(text) || null
      // [script-head-contract-fallback-v1] 脚本头契约：shebang 或 @desc 注释是脚本强特征
      // [WHY] AI 有时用非白名单语言标签（如 ```javascript / ```node / 无标签），三级判定得 null → script 被漏识别 →
      //   前端只收到 plain 走渲染不执行。命中契约特征时兜底认定 js，让符合脚本头契约的脚本能被无差别识别
      // [CONSTRAINT] 只认脚本头契约允许的两种形式（shebang / @desc）；误伤面：AI 复述 SYSTEM.md 示例会被当成脚本候选，
      //   由 lastMarked 优先级与 dedup hash 共同约束
      // [CHANGE-IMPACT] 影响 detectReplyInPage 的 kind 分流：修复后符合契约的脚本块稳定走 script 分支
      const _marked = /^#!\s*\/usr\/bin\/env\s+(?:node|bash)\b/m.test(text)
        || /^\s*\/\/\s*@desc\s*:/m.test(text)
        || /^\s*#\s*@desc\s*:/m.test(text)
      if (!lang && _marked) lang = 'js'
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

  /**
   * DOM → Markdown 反推：允许 AI 输出纯 Markdown 总结，但 DOM 抓取会丢换行
   * [WHY] textContent 会把 <h3>/<p>/<ul> 全部粘成一整行；需按标签结构重建 Markdown 源码
   * [CONSTRAINT] 只覆盖 DeepSeek 渲染使用的常见标签；未知标签递归取子节点文本（兜底）
   * [CHANGE-IMPACT] 输出直接喂给前端 renderMarkdown，标签→语法映射必须与其对齐
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
      const src = (code || el).textContent || ''
      return `\`\`\`${m ? m[1] : ''}\n${src.replace(/\n+$/g, '')}\n\`\`\`\n\n`
    }
    if (tag === 'code') return `\`${el.textContent || ''}\``
    if (tag === 'blockquote') return `${inner().split('\n').map((l: string) => `> ${l}`).join('\n')}\n\n`
    if (tag === 'table') {
      const rows: string[] = []
      for (const tr of Array.from(el.querySelectorAll('tr'))) {
        rows.push(`| ${Array.from(tr.children).map(c => elToMd(c).trim()).join(' | ')} |`)
      }
      return `${rows.join('\n')}\n\n`
    }
    return inner()
  }

  /** 从容器节点提取 Markdown；传入 document 时自动取 body */
  function extractReplyMd(root: Node | null): string {
    if (!root) return ''
    const node: Node | null = root.nodeType === 9 ? (root as Document).body : root
    if (!node) return ''
    return elToMd(node).replace(/\n{3,}/g, '\n\n').trim()
  }

  /**
   * 查找新已完成
   * [done-plain-v1] 新协议：首行严格 DONE + 后续 Markdown 总结（无需 js 围栏）
   * [CONSTRAINT] 只取最后一条 assistant 消息；首非空行 trim 后必须恰为 DONE
   * [CHANGE-IMPACT] marker 用首 200 字符 + 全长拼接；text 为 DOM→Markdown 反推结果（含换行）
   */
  function findNewDone() {
    const blocks = document.querySelectorAll('.ds-assistant-message-main-content')
    const root = blocks.length > 0 ? blocks[blocks.length - 1] : document
    const full = extractReplyMd(root)
    if (!full) return null
    const firstLine = full.split(/\r?\n/).find(l => l.trim().length > 0) || ''
    if (!/^\s*DONE\s*$/.test(firstLine)) return null
    const marker = hash32(`done-head|${full.slice(0, 200)}|${full.length}`)
    if (dedup.seenDoneMarkers.includes(marker)) return null
    return { marker, text: full }
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
    // [done-plain-v1] 不再要求 js 围栏：已允许纯 Markdown 总结
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
  const plainText = getMainText()
  if (!hasJsFence(plainText) && !isAskPrefix(plainText)) return null
  dedup._plainSentInCycle = true
  return { kind: 'plain', text: plainText }

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
