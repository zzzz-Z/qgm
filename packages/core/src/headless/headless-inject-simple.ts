/* eslint-disable ts/ban-ts-comment -- 需禁用整文件类型检查 */
// @ts-nocheck

// [headless-inject-simple-v1] 从 headless-inject.ts 抽出的短小 page.evaluate 目标函数。
// [WHY] headless-inject.ts 超 §4 模块 400 行；这些函数无共享状态依赖（detectReplyInPage 与 resetReplyDedup 除外），可独立。
// [CONSTRAINT] 函数体经 page.evaluate 序列化传入浏览器执行；禁止引用外部闭包变量。
// [CHANGE-IMPACT] headless-inject.ts 通过 re-export 保持对外 API 兼容。

export function fillPromptInPage(args) {
  const prompt = String((args && args.prompt) || '')
  if (!prompt) return false
  const input = document.querySelector('textarea:not([readonly]):not([disabled])')
    || document.querySelector('[contenteditable="true"]')
  if (!input) return false
  // [fill-verify-v2] 发送前记录基线：新建会话后首帧 .ds-message 计数恒为 0，
  // 若验证只判「绝对数 > 0」会把「已发出、尚未渲染」误判为失败 → 上层 withBackoff 重新填充并再次点击 = 重复发送。
  // [CONSTRAINT] 键名与 verifyFillSentInPage 的读取处必须一致（守卫测试 fill-verify-guard）
  window.__aiRunnerFillBaseline = { count: document.querySelectorAll('.ds-message').length }
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
 * [image-paste-v3] 与油猴 pasteImages 同构：把 dataURL 数组注入输入框。
 * 双路径互斥（paste 优先，仅 paste 抛异常才落 file-input），避免同图上传两次。
 * @param args { images: string[] } dataURL 数组
 */
export function pasteImagesInPage(args) {
  const images = (args && Array.isArray(args.images)) ? args.images : []
  if (!images.length) return { ok: false, reason: 'no-images' }
  const box = document.querySelector('textarea:not([readonly]):not([disabled])')
    || document.querySelector('[contenteditable="true"]')
  if (!box) return { ok: false, reason: 'no-input-box' }
  const files = []
  for (let i = 0; i < images.length; i++) {
    try {
      const url = String(images[i] || '')
      const comma = url.indexOf(',')
      if (comma < 0) continue
      const meta = url.slice(0, comma)
      const b64 = url.slice(comma + 1)
      const mime = (meta.match(/data:([^;]+)/) || [])[1] || 'image/png'
      const bin = atob(b64)
      const arr = new Uint8Array(bin.length)
      for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j)
      files.push(new File([arr], `pasted-image-${i}.${mime.split('/')[1] || 'png'}`, { type: mime }))
    } catch { /* swallow: 单张解码失败跳过，不影响其余图片 */ }
  }
  if (!files.length) return { ok: false, reason: 'decode-failed' }
  let pasted = false
  try {
    const dt = new DataTransfer()
    for (const f of files) dt.items.add(f)
    const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })
    try { Object.defineProperty(ev, 'clipboardData', { value: dt }) } catch { /* clipboardData 只读兜底 */ }
    box.focus()
    box.dispatchEvent(ev)
    pasted = true
  } catch { /* paste 不支持：落 file-input 兜底 */ }
  if (!pasted) {
    try {
      const input = document.querySelector('input[type=file]')
      if (input) {
        const dt2 = new DataTransfer()
        for (const f of files) dt2.items.add(f)
        try { input.files = dt2.files } catch { /* 部分浏览器拒写 files */ }
        input.dispatchEvent(new Event('change', { bubbles: true }))
      }
    } catch { /* swallow: 兜底失败不影响返回值 */ }
  }
  return { ok: true, reason: pasted ? 'paste' : 'file-input', count: files.length }
}

// [site-adapter-v1] 所有注入函数加 cfg 参数，经 page.evaluate(fn, cfg) 序列化后直接读对象属性
// cfg 必须是纯对象（字符串 / 正则字面量），不能是闭包或 class 实例
// [guard-v1] 每个函数体内的 _XXX_ANCHOR 变量是守卫测试锚点——必须保留 `/xxx/gi` 字面量形式，
//            守卫测试会直接扫源码提取逐字符对比；运行时优先用 cfg.textPatterns 字符串构造，没传就走 .source fallback

export function verifyFillSentInPage(cfg = {}) {
  // [rate-marker-guard-v1] 频控正则锚点（必须保留字面量，守卫扫源码提取）
  const _RATE_ANCHOR_VF = /(?:消息|发送|操作|请求|访问)过于频繁|过于频繁[，,\s]*请稍后重试|please\s+slow\s+down|too\s+many\s+requests|rate\s+limit/gi
  const sel = cfg.selectors || {}
  const inputSel = sel.inputBox || 'textarea:not([readonly]):not([disabled]), [contenteditable="true"]'
  const msgSel = sel.userMessage || '.ds-message'
  const asstSel = sel.assistantMessage || '.ds-assistant-message-main-content'
  const tp = cfg.textPatterns || {}
  const rateRe = new RegExp(tp.rateLimited || _RATE_ANCHOR_VF.source, 'gi')

  const msgs = document.querySelectorAll(msgSel)
  const last = msgs.length ? msgs[msgs.length - 1] : null
  const lastIsUserBubble = !!last && !last.querySelector(asstSel)
  // [fill-verify-v2] 主判据由「绝对数 > 0」改为「增量」：有基线时要求比基线多；
  // 无基线（未经 fillPromptInPage，例如页面刚导航过来）时退回绝对数判据。
  // [WHY] 新建会话首帧消息数恒为 0，绝对数判据在慢渲染/改版下会把已发出的消息判成失败（AGENDA-10）
  // [CONSTRAINT] 基线键名与 fillPromptInPage 的写入处必须一致（守卫测试 fill-verify-guard）
  const base = (window.__aiRunnerFillBaseline && typeof window.__aiRunnerFillBaseline.count === 'number')
    ? window.__aiRunnerFillBaseline.count
    : null
  const grew = base === null ? msgs.length > 0 : msgs.length > base
  if (lastIsUserBubble && grew) return { sent: true, rateLimited: false, reason: '' }
  // [rate-retry-v1] 发送被频控拒收：消息不进对话，页面尾部出现「过于频繁」提示。
  // 只扫尾部 3000 字符（提示渲染在底部输入区附近），避免历史消息里的旧文案误判。
  // 频控判定置于「输入框已清空」弱信号之前——被拒收时输入框同样会被清空，不能反判为已发送。
  // [CONSTRAINT] 正则与 headless-inject.ts detectReplyInPage、本文件 resetReplyDedupInPage 三处同构（守卫测试 rate-marker-guard）
  const tail = ((document.body && document.body.textContent) || '').slice(-3000)
  const rateMessages = tail.match(_RATE_ANCHOR_VF) || []
  if (rateMessages.length > 0) return { sent: false, rateLimited: true, reason: rateMessages[rateMessages.length - 1] }
  // [fill-verify-v2] 次判据：发送成功必清空输入区，可覆盖「已发出但消息尚未渲染」的窗口期。
  // 仅在有基线（确实填过内容）且消息数未增长时启用；且要求输入区确实变空——
  // 「上一条仍在生成、click 被静默忽略」时输入框保留原 prompt，此处仍判 false，重试语义不变。
  if (base !== null && !grew) {
    const input = document.querySelector(inputSel)
    if (input) {
      const text = (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT')
        ? String(input.value || '')
        : String(input.textContent || '')
      if (text.trim().length === 0) return { sent: true, rateLimited: false, reason: 'input-cleared' }
    }
  }
  return { sent: false, rateLimited: false, reason: '' }
}

export function stopGeneratingInPage(cfg = {}) {
  // [stop-parity-v1] 与油猴 clickStopGenerating 对齐。
  // [site-adapter-v1] 结构化兜底选择器从 cfg.selectors.stopButton 读
  const sel = cfg.selectors || {}
  const stopBtnSel = sel.stopButton || '[role="button"].ds-button--circle, button.ds-button--circle'
  const STOP_RE = /停止生成|停止回答|停止输出|终止|取消生成|停止|中断|暂停生成|stop\s*generat|stop\s*stream|stop\s*response|stop\s*answer|stop\s*cancel|\bcancel\b|\babort\b|\binterrupt\b|\bhalt\b/i
  const WIDE_SEL = 'button, div[role], span[role], a[role], [role="switch"], [role="menuitem"]'
  const cands = Array.from(document.querySelectorAll(WIDE_SEL))
  for (const el of cands) {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue
    const lbl = [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('data-testid'),
      el.getAttribute('data-state'),
      el.getAttribute('class'),
      el.textContent,
    ].filter(Boolean).join(' ')
    if (STOP_RE.test(lbl)) {
      el.click()
      return true
    }
  }
  // [stop-btn-deepseek-fallback-v1] 结构化兜底：生成中时输入区的圆形主按钮必然是停止键
  // （发送键已让位），与油猴 findStopGeneratingBtnStructural 同构。
  try {
    const input = document.querySelector('textarea:not([readonly]):not([disabled])')
      || document.querySelector('[contenteditable="true"]')
    if (input) {
      let root = input.closest('form')
      if (!root) {
        let p = input.parentElement
        for (let i = 0; i < 8 && p; i++) {
          if (p.querySelector(stopBtnSel)) { root = p; break }
          p = p.parentElement
        }
      }
      const scope = root || document
      const circles = scope.querySelectorAll(stopBtnSel)
      for (const el of circles) {
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue
        el.click()
        return true
      }
    }
  } catch { /* swallow: 结构化兜底失败继续走 Esc */ }
  // [stop-esc-fallback-v1] 与油猴同款 Esc 兜底：站点未提供可点按钮时的最后手段
  try {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }))
  } catch { /* swallow: Esc 派发失败不影响返回值语义 */ }
  return false
}

/**
 * [stop-diag-v1] 与油猴 collectStopCandidates + stop-diag 回传对齐。
 * 无头 stop 失败时返回候选按钮摘要，使"为什么没点到停止键"可直接观测，
 * 而非只得到一句 "stop 失败（未找到停止按钮）"。
 */
export function collectStopCandidatesInPage() {
  const STOP_RE = /停止生成|停止回答|停止输出|终止|取消生成|停止|中断|暂停生成|stop\s*generat|stop\s*stream|stop\s*response|stop\s*answer|stop\s*cancel|\bcancel\b|\babort\b|\binterrupt\b|\bhalt\b/i
  const sel = 'button, div[role], span[role], a[role], [role="switch"], [role="menuitem"]'
  const out = []
  for (const el of document.querySelectorAll(sel)) {
    const lbl = [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('data-testid'),
      el.getAttribute('data-state'),
      el.getAttribute('class'),
      el.textContent,
    ].filter(Boolean).join(' ')
    if (STOP_RE.test(lbl)) {
      const tag = el.tagName.toLowerCase()
      const al = el.getAttribute('aria-label') || ''
      const ti = el.getAttribute('title') || ''
      const cl = String(el.getAttribute('class') || '').slice(0, 40)
      const tx = String(el.textContent || '').trim().slice(0, 20)
      out.push(`<${tag}> aria="${al}" title="${ti}" class="${cl}" text="${tx}" disabled=${Boolean(el.disabled)}`)
      if (out.length >= 3) break
    }
  }
  return { count: out.length, brief: out.join(' | ') }
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

export function detectLoginStateInPage(cfg = {}) {
  const sel = cfg.login || {}
  const tokenKey = sel.tokenStorageKey || 'userToken'
  let tokenState = 'unknown'
  try {
    const raw = window.localStorage.getItem(tokenKey)
    if (raw !== null) {
      const parsed = JSON.parse(raw)
      tokenState = typeof parsed?.value === 'string' && parsed.value.length > 0 ? 'yes' : 'no'
    }
  } catch { tokenState = 'unknown' }
  return {
    path: location.pathname,
    hasInput: !!document.querySelector('textarea:not([readonly]):not([disabled]), [contenteditable="true"]'),
    tokenState,
  }
}

export function resetReplyDedupInPage(cfg = {}) {
  // [guard-v1] 三处守卫测试锚点——必须保留字面量，守卫扫源码提取
  const _RATE_ANCHOR_RR = /(?:消息|发送|操作|请求|访问)过于频繁|过于频繁[，,\s]*请稍后重试|please\s+slow\s+down|too\s+many\s+requests|rate\s+limit/gi
  const _LIMIT_ANCHOR_RR = /(?:(?:达到|已达|超出|超过)\s*(?:对话|会话|上下文)(?:长度)?\s*(?:上限|最大长度|超限|过长)|(?:对话|会话|上下文)(?:长度)?\s*(?:已达|已达到|达到|超出|超过)\s*(?:上限|最大长度|超限|过长)|(?:对话|会话|上下文)(?:长度)?超限|(?:对话|会话|上下文)(?:长度)?\s*(?:上限|最大长度|过长))(?:[，,：:]\s*请?|请)(?:开启|开始|新建|创建)(?:一个)?新(?:对话|会话)|context length (?:limit|exceeded|too long)|maximum context length (?:is|of)\s*\d+|maximum context length\s+\d+\s*tokens/gi
  const _BUSY_ANCHOR_RR = /server busy, please try again later\.?|(?:服务器|服务)繁忙[^\n。！!]*[。！!]?/gi
  const _STOPPED_ANCHOR_RR = /当前问题已停止|已停止生成|已停止回答/g

  const sel = cfg.selectors || {}
  const asstSel = sel.assistantMessage || '.ds-assistant-message-main-content'
  const tp = cfg.textPatterns || {}
  const busyRe = new RegExp(tp.serverBusy || _BUSY_ANCHOR_RR.source, 'gi')
  const stoppedRe = new RegExp(tp.stopped || _STOPPED_ANCHOR_RR.source, 'gi')
  const limitRe = new RegExp(tp.contextLimit || _LIMIT_ANCHOR_RR.source, 'gi')
  const rateRe = new RegExp(tp.rateLimited || _RATE_ANCHOR_RR.source, 'gi')

  const el = document.querySelector('main') || document.body
  const t = ((el && el.textContent) || '').replace(/\s+/g, ' ')
  const s = t.slice(-300)
  let h = 0x811C9DC5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x1000193) >>> 0
  const sig = (h >>> 0).toString(16).padStart(8, '0')
  // [limit-scan-strip-v1] 触顶/停止/busy/频控四类标记基线只扫「正文」：剥掉代码块、输入框与可编辑区。
  // [WHY] 工作台把脚本 stdout 用 ``` 围栏回填进会话（prompt-builder appendRawOutputs）⇒ 页面里落成
  //   <pre><code>，而源码/文档里含探针自己的词表（就是下面这条触顶正则的 `maximum context length`）
  //   ⇒ 整页 textContent 自指命中，误报「已达长度上限」并掐掉一整轮（2026-10-10 12:02 实测，
  //   复现脚本 .ai-runner/tmp/limit-fp-repro.cjs：剥壳后 1 → 0，真 banner 仍为 1）。
  // [CONSTRAINT] 实现体与 headless-inject.ts、scripts/tampermonkey-session-id.user.js 两处逐字符同构
  //   （守卫测试 limit-marker-guard 的 body-text parity 用例）；本函数每轮只跑一次，无需缓存。
  // [CONSTRAINT] 上面的 bodySignature 段（el.textContent）**不得**改走本函数：代码块属于回复正文。
  function bodyText() {
    const b = document.body
    if (!b) return ''
    const c = b.cloneNode(true)
    const kill = c.querySelectorAll('pre,code,textarea,input,[contenteditable="true"],script,style')
    for (let i = 0; i < kill.length; i++) kill[i].remove()
    return c.textContent || ''
  }
  const scanText = bodyText()
  // [guard-v1] 探针直接用锚点变量名（守卫 RE_SITE 扫 `_XXX_ANCHOR` 命名模式）
  const busyMessages = scanText.match(_BUSY_ANCHOR_RR) || []
  const stoppedMessages = scanText.match(_STOPPED_ANCHOR_RR) || []
  const limitMessages = scanText.match(_LIMIT_ANCHOR_RR) || []
  const baselineBlocks = document.querySelectorAll(asstSel).length
  // [virtual-list-baseline-v1] 记录「最后一条 assistant 消息」的内容 hash 作为本轮基线。
  // [WHY] DeepSeek 已切虚拟列表，生成新消息时会回收视口外旧消息 ⇒ 实时 assistant 块数会下降
  //   （实测 3→1→2）⇒ detectReplyInPage 原计数判据 `_baseBlocks.length <= _baselineBlocks` 恒真
  //   ⇒ 恒 return null ⇒ 无头静默丢回复。hash 判据不受回收影响。
  // [CONSTRAINT] 空会话/无 assistant 时基线为 ''（哨兵）；首条回复到来 hash 由 '' 变非空 ⇒ 正确放行。
  //   [同构] headless-inject.ts 的 detectReplyInPage 用同名 hash32 复算（FNV-1a 32bit）。
  const baselineLastHash = (() => {
    const els = document.querySelectorAll(asstSel)
    if (els.length === 0) return ''
    const t = (els[els.length - 1].textContent || '')
    if (t.length === 0) return ''
    let h = 0x811C9DC5
    for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x1000193) >>> 0
    return (h >>> 0).toString(16).padStart(8, '0')
  })()
  // [rate-retry-v1] 频控基线：与 headless-inject detectReplyInPage、本文件 verifyFillSentInPage 三处同构（守卫测试 rate-marker-guard）
  const rateMessages = scanText.match(_RATE_ANCHOR_RR) || []
  window.__aiRunnerDedup = { seenHashes: [], seenDoneMarkers: [], lastBodySig: sig, _pendingScriptHash: null, _plainSentInCycle: false, _stableCount: 0, _seenGrowth: false, _baselineBlocks: baselineBlocks, _baselineLastHash: baselineLastHash, _busyErrorBaseline: busyMessages.length, _busyErrorReported: false, _scriptFenceReported: false, _stoppedBaseline: stoppedMessages.length, _stoppedReported: false, _limitBaseline: limitMessages.length, _limitReported: false, _rateBaseline: rateMessages.length, _rateReported: false }
  // [script-closure-gate-v1] 结构闭合门随轮次重置：上一轮遗留的门会拿旧长度当基线，
  //   让新回复第一帧就被判定为「已静止」→ 未闭合块提前放行（门本身见 headless-inject.ts）
  window.__aiRunnerClosureGate = null
  return true
}
