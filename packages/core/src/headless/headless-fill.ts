/* eslint-disable ts/ban-ts-comment -- 需禁用整文件类型检查 */
// @ts-nocheck

// [headless-fill-v1] 从 headless-inject.ts 抽出的短小 page.evaluate 目标函数。
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
  // [fill-verify-v3] 有基线时判「增量区域里出现过任意 user 气泡」，不再要求**末条**是 user 气泡。
  // [WHY] 2026-10-18 实测：极短回复（「收到」）在 verify 完成前就已渲染 ⇒ 末条已是 assistant 气泡
  //   ⇒ lastIsUserBubble=false ⇒ 明明发出却报 ok:false。客户端把 ok:false 映射成 failed
  //   （toast「发送失败」+ softPause），一次成功发送被显示成失败，正是本函数要消灭的误判。
  //   增量区域（slice(base)）里存在 user 气泡 = 确有一条新用户消息落进对话，判据仍承重：
  //   只有 assistant 新块（base=2→3）没有 user 气泡，依旧判未发送。
  // [CONSTRAINT] 无基线时保持旧语义（末条须为 user 气泡）：此时无法界定「新增区」，放宽会命中历史消息。
  let grewUserBubble = lastIsUserBubble && grew
  if (base !== null && grew) {
    // [CONSTRAINT] 此处禁止 TS 类型注解：守卫测试把这整个函数体抠出来在 vm 里直接跑（同 scanReplyMarks）
    const arr = Array.prototype.slice.call(msgs, base)
    grewUserBubble = arr.some(m => !m.querySelector(asstSel))
  }
  if (grewUserBubble) return { sent: true, rateLimited: false, reason: '' }
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

// [newsession-parity-v1] 与油猴侧 actions.ts 的 clickNewSession 逐条对齐：
//   ① 候选选择器补 [role="button"]；② 文案候选补「新建会话/开启新对话」；
//   ③ 匹配字段补 data-testid；④ 按钮 disabled 时视为未命中；⑤ 找不到时跳根路径兜底。
//   原实现只认 button/a + 三个文案，DeepSeek 改版后恒返回 false（实测 click-fail）。
export function clickNewSessionInPage() {
  // [newsession-textnode-v1] DeepSeek 的「New chat」按钮是纯图标 + 文本节点结构：
  //   <span>New chat</span> 包在一个可点击 div（._5a8ac7a）里，button/aria-label/title 全为空。
  //   原实现只扫 button/a/[role=button] 的 aria/text/title/testid ⇒ 恒命中不到（实测 177 个候选 0 命中）。
  //   改为：遍历文本节点找到关键词，再向上找可点击祖先（button / role=button / onclick / 有 class 的 div）。
  const KW = /^(?:新建对话|新对话|新建聊天|新建会话|开启新对话|new\s*chat|new\s*conversation)$/i
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  let node: Node | null = null
  while ((node = walker.nextNode())) {
    if (!KW.test(String(node.textContent || '').trim())) continue
    let el: HTMLElement | null = node.parentElement
    for (let depth = 0; depth < 6 && el; depth++) {
      const clickable = el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || typeof (el as HTMLElement).onclick === 'function' || (el.className || '').toString().includes('_5a8ac7a')
      if (clickable && !(el as HTMLButtonElement).disabled) {
        try { el.click(); return true } catch { /* 点击失败：落跳转兜底 */ }
      }
      el = el.parentElement
    }
    // 文本已命中但找不到可点击祖先：直接点它的父级兜底
    const fallback = node.parentElement?.parentElement
    if (fallback) { try { fallback.click(); return true } catch { /* 落跳转兜底 */ } }
    break
  }
  // [CONSTRAINT] 已在根路径时不再赋值 location.href：会触发整页重载并重建无头页面。
  const root = `${location.origin}/`
  if (location.href !== root && location.pathname !== '/') {
    location.href = root
    return true
  }
  return false
}

/** [poll-diag-v1] poll 眼中的页面状态快照（排查「SSE 有内容但 detectReplyInPage 读不到」） */
export function collectPageDiagInPage() {
  const els = document.querySelectorAll('.ds-assistant-message-main-content')
  const last = els.length ? (els[els.length - 1].textContent || '') : ''
  let h = 0x811C9DC5
  for (let i = 0; i < last.length; i++) h = Math.imul(h ^ last.charCodeAt(i), 0x1000193) >>> 0
  const nowHash = last.length ? (h >>> 0).toString(16).padStart(8, '0') : ''
  const dedup = window.__aiRunnerDedup || {}
  return {
    url: location.href,
    asst: els.length,
    msg: document.querySelectorAll('.ds-message').length,
    bodyLen: (document.body.textContent || '').length,
    nowHash,
    baseHash: typeof dedup._baselineLastHash === 'string' ? dedup._baselineLastHash : 'MISSING',
    baseBlocks: typeof dedup._baselineBlocks === 'number' ? dedup._baselineBlocks : -1,
    lastLen: last.length,
    // [poll-diag-v2] 稳定门槛诊断：sig 一直在变 ⇒ _stableCount 永远到不了 3，plain 分支永不触发
    stableCount: typeof dedup._stableCount === 'number' ? dedup._stableCount : -1,
    seenGrowth: Boolean(dedup._seenGrowth),
    plainSent: Boolean(dedup._plainSentInCycle),
    lastBodySig: String(dedup.lastBodySig || ''),
    seenHashes: Array.isArray(dedup.seenHashes) ? dedup.seenHashes.length : -1,
    // [poll-diag-v3] 区分 plain 分支各出口：hasJsFence / marks / stopped / 裸 SCRIPT 围栏
    plainLen: (() => { try { return String((document.querySelectorAll('.ds-assistant-message-main-content').length ? (document.querySelectorAll('.ds-assistant-message-main-content')[document.querySelectorAll('.ds-assistant-message-main-content').length - 1].textContent || '') : '')).length } catch { return -1 } })(),
    preCnt: (() => { try { const els = document.querySelectorAll('.ds-assistant-message-main-content'); if (!els.length) return -1; return els[els.length - 1].querySelectorAll('pre code, pre').length } catch { return -1 } })(),
    stopped: Boolean(dedup._stoppedReported),
    scriptFence: Boolean(dedup._scriptFenceReported),
    // [poll-diag-v4] 锁定 plain 分支为何 return null：需 marks 与 plainText 实测
    marks: (() => { try { const els = document.querySelectorAll('.ds-assistant-message-main-content'); const root = els.length ? els[els.length - 1] : null; const md = (function elToMd(node) { if (!node) return ''; if (node.nodeType === 3) return node.textContent || ''; if (node.nodeType !== 1) return ''; const el = node; const tag = el.tagName.toLowerCase(); const inner = () => Array.from(el.childNodes).map(elToMd).join(''); if (tag === 'br') return '\n'; if (tag === 'hr') return '\n---\n\n'; if (/^h[1-6]$/.test(tag)) return `${'#'.repeat(Number(tag.charAt(1)))} ${inner().trim()}\n\n`; if (tag === 'p') return `${inner().trim()}\n\n`; if (tag === 'ul' || tag === 'ol') { const o = []; let i = 1; for (const c of Array.from(el.children)) { if (c.tagName.toLowerCase() !== 'li') continue; o.push((tag === 'ul' ? '- ' : `${i++}. `) + elToMd(c).trim()) } return `${o.join('\n')}\n\n` } if (tag === 'pre') { const c = el.querySelector('code'); const lang = c ? ((c.className || '').match(/(?:language|lang)-([a-z0-9+#-]+)/i) || [])[1] || '' : ''; return `\`\`\`${lang}\n${((c || el).textContent || '').replace(/\n+$/, '')}\n\`\`\`\n\n` } return inner() })(root); const lines = md.split(/\r?\n/); let head = -1; for (let i = 0; i < lines.length; i++) { if (lines[i].trim().length > 0) { head = i; break } } const out = { script: -1, ask: -1, done: -1, handoff: -1, text: -1 }; if (head >= 0) { const line = lines[head].trim(); if (line === 'SCRIPT')out.script = head + 1; else if (line === 'ASK')out.ask = head + 1; else if (line === 'DONE')out.done = head + 1; else if (line === 'HANDOFF')out.handoff = head + 1; else if (line === 'TEXT')out.text = head + 1 } return out } catch { return null } })(),
    plainHead: (() => { try { const els = document.querySelectorAll('.ds-assistant-message-main-content'); if (!els.length) return ''; const t = (els[els.length - 1].textContent || ''); return t.slice(0, 40) } catch { return '' } })(),
    pendingScriptHash: String(dedup._pendingScriptHash || ''),
    pendingDoneSig: String(dedup._pendingDoneSig || ''),
    // [gen-gate-diag-v1] 补上 isGeneratingInPage 的观测盲区：它一旦恒真，
    //    script 分支会在 :699 被永久拦住、plain 短回复在 :762 被拦住，
    //   而且**所有 hits 计数器都不增加**（那两道门都在计数之前 return）——
    //   2026-10-18 实测「AI 回复了 553 字脚本、hits 全 0、stableCount=0」正是这个形态，
    //   但旧 diag 只记 dedup.stopped（≠ 页面生成态），导致只能靠猜。
    // [CONSTRAINT] 这里**不复制** isGeneratingInPage 的布尔判据（副本必然与真判据漂移），
    //   只吐原始证据：哪些可见元素命中了 stop 语义、圆钮有几个。真假由人判。
    genHit: (() => {
      try {
        const re = /停止生成|停止回答|停止输出|终止|取消生成|停止|中断|暂停生成|stop\s*generat|stop\s*stream|stop\s*response|stop\s*answer|stop\s*cancel|\bcancel\b|\babort\b|\binterrupt\b|\bhalt\b/i
        const out: string[] = []
        for (const el of document.querySelectorAll('button, div[role], span[role], a[role], [role="switch"], [role="menuitem"]')) {
          const e = el as HTMLElement
          if ((e as HTMLButtonElement).disabled || e.getAttribute('aria-disabled') === 'true') continue
          if (e.offsetParent === null) continue
          const lbl = [e.getAttribute('aria-label'), e.getAttribute('title'), e.getAttribute('data-state'), e.getAttribute('class'), (e.textContent || '').slice(0, 40)].filter(Boolean).join(' ')
          if (re.test(lbl)) {
            out.push(`${e.tagName}.${String(e.className || '').slice(0, 36)}|${String(e.getAttribute('aria-label') || '-').slice(0, 24)}`)
            if (out.length >= 3) break
          }
        }
        return out
      } catch { return [] }
    })(),
    circle: (() => { try { return document.querySelectorAll('[role="button"].ds-button--circle, button.ds-button--circle').length } catch { return -1 } })(),
    hasBox: (() => { try { return Boolean(document.querySelector('textarea:not([readonly]):not([disabled]), [contenteditable="true"]')) } catch { return false } })(),
    hits: {
      sig2: dedup._hitSig2 || 0,
      sigChanged: dedup._hitSigChanged || 0,
      noGrowth: dedup._hitNoGrowth || 0,
      plainSent: dedup._hitPlainSent || 0,
      stableLow: dedup._hitStableLow || 0,
      // [short-reply-gate-v1] 极短回复闸门三态计数：wait（继续等）/ pass（已交付）/ dup（同文本已交付）
      // [改名] 旧字段 jsFence 名不副实：它统计的从来不是「js 围栏」，而是「极短文本被当噪音丢弃」的次数，
      //   2026-10-18 排查时就因为这个名字把根因误判成 bodySignature 抖动，故改名并在新日志里弃用 jsFence。
      shortGate: dedup._hitShortGate || 0,
      shortPass: dedup._hitShortPass || 0,
      shortDup: dedup._hitShortDup || 0,
      stopped: dedup._hitStopped || 0,
      scriptNoise: dedup._hitScriptNoise || 0,
      fenceSuppress: dedup._hitFenceSuppress || 0,
      // [ask-dedup-v1] ASK 同内容重复拦截次数。ASK 是唯一绕过 _plainSentInCycle 的出口，
      //   这个计数持续增长 = 去重在工作；恒为 0 而 marks.ask=1 连拍多拍 = 每拍都在重复交付。
      //   [WHY 必须单独记] 2026-10-18 刷屏事故里 marks.ask=1、stableCount 一路涨、却没有任何一个
      //   既有 hit 计数变化，日志看起来「一切正常」，只能靠 reply 条数反推。
      askDup: dedup._hitAskDup || 0,
    },
  }
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
  // [login-cookie-v1] 多源判据：DeepSeek 的会话标识并不总在 localStorage.userToken 里
  //   （实测登录后 Cookies 表仍只有匿名条目，localStorage 也读不到 → 原判据恒 unknown）。
  //   补一条 cookie 探针：存在非匿名会话 cookie 即视为登录态正面证据。
  //   [CONSTRAINT] 只做「存在性」判断，不解析具体值；匿名标记（HWWAFSESID / smidV2 / thumbcache）排除。
  let cookieLoggedIn = false
  try {
    const raw = String(document.cookie || '')
    if (raw) {
      const ANON = /^(?:HWWAFSESID|HWWAFSESTIME|smidV2|ds_session_id|\.thumbcache_)/i
      cookieLoggedIn = raw.split(';').some((pair) => {
        const name = pair.split('=')[0].trim()
        return Boolean(name) && !ANON.test(name)
      })
    }
  } catch { /* swallow: cookie 不可读时保持 false */ }
  if (tokenState !== 'yes' && cookieLoggedIn) tokenState = 'yes'
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
  // [stopped-btn-v1] 原「已停止」关键词锚点变量（三个词的那条正则）随关键词 stopped 探针
  //   一起移除：DeepSeek 真实角标零命中（bundle 实证）+ AI 正文自指假阳性。
  //   stopped 判定改按钮状态驱动，detectReplyInPage 内 isGeneratingInPage 跨 poll 追踪，
  //   无文本基线可重置——只需把「上一 poll 是否在生成」清成 false。

  const sel = cfg.selectors || {}
  const asstSel = sel.assistantMessage || '.ds-assistant-message-main-content'
  const tp = cfg.textPatterns || {}
  const busyRe = new RegExp(tp.serverBusy || _BUSY_ANCHOR_RR.source, 'gi')
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
  window.__aiRunnerDedup = { seenHashes: [], seenDoneMarkers: [], lastBodySig: sig, _pendingScriptHash: null, _plainSentInCycle: false, _stableCount: 0, _seenGrowth: false, _baselineBlocks: baselineBlocks, _baselineLastHash: baselineLastHash, _busyErrorBaseline: busyMessages.length, _busyErrorReported: false, _scriptFenceReported: false, _prevGenBtn: false, _stoppedReported: false, _limitBaseline: limitMessages.length, _limitReported: false, _rateBaseline: rateMessages.length, _rateReported: false, _shortSentHash: '', _askSentHash: '' }
  // [script-closure-gate-v1] 结构闭合门随轮次重置：上一轮遗留的门会拿旧长度当基线，
  //   让新回复第一帧就被判定为「已静止」→ 未闭合块提前放行（门本身见 headless-inject.ts）
  window.__aiRunnerClosureGate = null
  return true
}
