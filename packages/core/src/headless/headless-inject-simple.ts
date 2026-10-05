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

export function verifyFillSentInPage() {
  const msgs = document.querySelectorAll('.ds-message')
  const last = msgs.length ? msgs[msgs.length - 1] : null
  const lastIsUserBubble = !!last && !last.querySelector('.ds-assistant-message-main-content')
  // [fill-verify-v2] 主判据由「绝对数 > 0」改为「增量」：有基线时要求比基线多；
  // 无基线（未经 fillPromptInPage，例如页面刚导航过来）时退回绝对数判据。
  // [WHY] 新建会话首帧 .ds-message 恒为 0，绝对数判据在慢渲染/改版下会把已发出的消息判成失败（AGENDA-10）
  // [CONSTRAINT] 基线键名与 fillPromptInPage 的写入处必须一致（守卫测试 fill-verify-guard）
  const base = (window.__aiRunnerFillBaseline && typeof window.__aiRunnerFillBaseline.count === 'number')
    ? window.__aiRunnerFillBaseline.count
    : null
  const grew = base === null ? msgs.length > 0 : msgs.length > base
  if (lastIsUserBubble && grew) return { sent: true, rateLimited: false, reason: '' }
  // [rate-retry-v1] 发送被频控拒收：消息不进对话，页面尾部出现「过于频繁」提示。
  // 只扫尾部 3000 字符（提示渲染在底部输入区附近），避免历史消息里的旧文案误判。
  // 频控判定置于「输入框已清空」弱信号之前——被拒收时输入框同样会被清空，不能反判为已发送。
  // [CONSTRAINT] 正则与 headless-inject.ts detectReplyInPage、本文件 resetReplyDedupInPage 三处内联同构（守卫测试 rate-marker-guard）
  const tail = ((document.body && document.body.textContent) || '').slice(-3000)
  const rateMessages = tail.match(/(?:消息|发送|操作|请求|访问)过于频繁|过于频繁[，,\s]*请稍后重试|please\s+slow\s+down|too\s+many\s+requests|rate\s+limit/gi) || []
  if (rateMessages.length > 0) return { sent: false, rateLimited: true, reason: rateMessages[rateMessages.length - 1] }
  // [fill-verify-v2] 次判据：DeepSeek 发送成功必清空输入区，可覆盖「已发出但消息尚未渲染」的窗口期。
  // 仅在有基线（确实填过内容）且消息数未增长时启用；且要求输入区确实变空——
  // 「上一条仍在生成、click 被静默忽略」时输入框保留原 prompt，此处仍判 false，重试语义不变。
  if (base !== null && !grew) {
    const input = document.querySelector('textarea:not([readonly]):not([disabled])')
      || document.querySelector('[contenteditable="true"]')
    if (input) {
      const text = (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT')
        ? String(input.value || '')
        : String(input.textContent || '')
      if (text.trim().length === 0) return { sent: true, rateLimited: false, reason: 'input-cleared' }
    }
  }
  return { sent: false, rateLimited: false, reason: '' }
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

export function detectLoginStateInPage() {
  let tokenState = 'unknown'
  try {
    const raw = window.localStorage.getItem('userToken')
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

export function resetReplyDedupInPage() {
  const el = document.querySelector('main') || document.body
  const t = ((el && el.textContent) || '').replace(/\s+/g, ' ')
  const s = t.slice(-300)
  let h = 0x811C9DC5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x1000193) >>> 0
  const sig = (h >>> 0).toString(16).padStart(8, '0')
  const busyMessages = ((document.body && document.body.textContent) || '').match(/server busy, please try again later\.?|(?:服务器|服务)繁忙[^\n。！!]*[。！!]?/gi) || []
  const stoppedMessages = ((document.body && document.body.textContent) || '').match(/当前问题已停止|已停止生成|已停止回答/g) || []
  // [limit-detect-v2] 会话长度上限基线：与 headless-inject detectReplyInPage 的正则严格同构（改一处必须同步两处）
  const limitMessages = ((document.body && document.body.textContent) || '').match(/(?:达到|已达|超出|超过)\s*(?:对话|会话|上下文)(?:长度)?\s*(?:上限|最大长度|超限|过长)|(?:对话|会话|上下文)(?:长度)?\s*(?:已达|已达到|达到|超出|超过)\s*(?:上限|最大长度|超限|过长)|(?:对话|会话|上下文)(?:长度)?超限|(?:对话|会话|上下文)(?:长度)?\s*(?:上限|最大长度|过长)[，,：:]?\s*请?(?:开启|开始|新建|创建)(?:一个)?新(?:对话|会话)|context length (?:limit|exceeded|too long)|maximum context length/gi) || []
  const baselineBlocks = document.querySelectorAll('.ds-assistant-message-main-content').length
  // [rate-retry-v1] 频控基线：与 headless-inject detectReplyInPage、本文件 verifyFillSentInPage 三处内联同构（守卫测试 rate-marker-guard）
  const rateMessages = ((document.body && document.body.textContent) || '').match(/(?:消息|发送|操作|请求|访问)过于频繁|过于频繁[，,\s]*请稍后重试|please\s+slow\s+down|too\s+many\s+requests|rate\s+limit/gi) || []
  window.__aiRunnerDedup = { seenHashes: [], seenDoneMarkers: [], lastBodySig: sig, _pendingScriptHash: null, _plainSentInCycle: false, _stableCount: 0, _seenGrowth: false, _baselineBlocks: baselineBlocks, _busyErrorBaseline: busyMessages.length, _busyErrorReported: false, _stoppedBaseline: stoppedMessages.length, _stoppedReported: false, _limitBaseline: limitMessages.length, _limitReported: false, _rateBaseline: rateMessages.length, _rateReported: false }
  // [script-closure-gate-v1] 结构闭合门随轮次重置：上一轮遗留的门会拿旧长度当基线，
  //   让新回复第一帧就被判定为「已静止」→ 未闭合块提前放行（门本身见 headless-inject.ts）
  window.__aiRunnerClosureGate = null
  return true
}
