// @ts-nocheck
// [tampermonkey-ts-rewrite-v1] IIFE 物理切分片段，非独立模块；跨片段符号在单文件检查下不可见。
//   全部片段 TS 化完成、按拼回后的联合视图接线后再移除本 pragma。

/**
 * 输入框与发送 —— 把工作台下发的 prompt 真正塞进站点并触发发送。
 *
 * [WHY] 站点输入框有三类实现，注入方式完全不同，必须按序回退：
 *   ① 原生 textarea / input —— 走原型链 setter 才能让 React 感知值变化（直接赋值不触发 onChange）；
 *   ② Slate / ProseMirror 等富文本 —— 走 ClipboardEvent('paste')，这是它们的官方识别路径；
 *   ③ 兜底 —— document.execCommand('insertText')，兼容既非原生也非主流富文本的实现。
 *   任何一级缺失都会表现成「输入框看起来填上了，但发送按钮仍是禁用态」。
 */

/**
 * 定位输入框。
 * [CONSTRAINT] 千问用 div[contenteditable][role=textbox]，其余站点多为 textarea；
 *   这里把 contenteditable 放在最前是因为它更特异，避免误抓页面上的搜索框。
 */
function findInputBox(): HTMLElement | null {
  const qwen = document.querySelector('div[contenteditable="true"][role="textbox"]')
  if (qwen) return qwen as HTMLElement
  const ta = document.querySelector('textarea:not([readonly]):not([disabled])')
  if (ta) return ta as HTMLElement
  return (document.querySelector('[contenteditable="true"]') as HTMLElement) || null
}

/**
 * 定位发送按钮。
 * [CONSTRAINT] 正则用 /发送|send|submit/i 而非 /^发送$/：真站点的按钮多为图标 + 变体文案，
 *   早期要求纯文本等于「发送」导致三步全 miss，最终退化成合成 Enter（部分站点不响应）。
 *   三级回退：已知站点专用选择器 → 文案匹配 → form 内 submit。
 */
function findSendButton(input: HTMLElement | null): HTMLElement | null {
  const qwenBtn = document.querySelector('button[aria-label="发送消息"]') as HTMLButtonElement | null
  if (qwenBtn && !qwenBtn.disabled) return qwenBtn
  const allClickable = Array.from(document.querySelectorAll('button, div[role="button"]'))
  const byLabel = allClickable.find((b) => {
    if ((b as HTMLButtonElement).disabled || b.getAttribute('aria-disabled') === 'true') return false
    const lbl = [b.getAttribute('aria-label'), b.getAttribute('title'), b.getAttribute('data-testid'), b.textContent].filter(Boolean).join(' ')
    return /发送|send|submit/i.test(lbl)
  })
  if (byLabel) return byLabel as HTMLElement
  if (input && input.closest('form')) {
    const form = input.closest('form') as HTMLFormElement
    const sb = form.querySelector('button[type=submit]:not([disabled])')
    if (sb) return sb as HTMLElement
  }
  return null
}

/**
 * 合成 Enter 键序列。
 * [CONSTRAINT] keydown / keypress / keyup 三个都要发：
 *   部分框架只监听 keydown，另一些在 keypress 阶段才拦截，只发一个会静默无效。
 */
function sendEnter(box: HTMLElement): void {
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

/**
 * DataURL → File，用于把图片粘贴进富文本输入框。
 * [CONSTRAINT] 只解析 data:image/*;base64 前缀；解析失败返回 null 由调用方跳过，
 *   不阻断文本填入（图片失败不该让整条指令失败）。
 */
function dataUrlToFile(dataUrl: string, name: string): File | null {
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

/**
 * 把图片注入输入框。
 * [CONSTRAINT] paste 与 file-input 两条路径必须**互斥**：两者在 DeepSeek 上都会生效，
 *   并发执行会让同一张图上传两次（实测「一张变两张」）。
 *   判据用「paste 是否抛异常」而非「是否被站点消费」——dispatchEvent 无返回值，无法观测消费。
 */
function pasteImages(box: HTMLElement, images: string[]): void {
  if (!box || !Array.isArray(images) || !images.length) return
  const files: File[] = []
  for (let i = 0; i < images.length; i++) {
    const f = dataUrlToFile(images[i], `pasted-image-${i}`)
    if (f) files.push(f)
  }
  if (!files.length) return

  let pasted = false
  try {
    const dt = new DataTransfer()
    for (const f of files) dt.items.add(f)
    const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })
    try { Object.defineProperty(ev, 'clipboardData', { value: dt }) } catch { /* 构造后只读，defineProperty 兜底 */ }
    box.focus()
    box.dispatchEvent(ev)
    pasted = true
  } catch { /* paste 不被支持：落 file-input 兜底 */ }

  if (!pasted) {
    try {
      const input = document.querySelector('input[type=file]') as HTMLInputElement | null
      if (input) {
        const dt2 = new DataTransfer()
        for (const f of files) dt2.items.add(f)
        try { input.files = dt2.files } catch { /* 部分浏览器 security 拒写 files */ }
        input.dispatchEvent(new Event('change', { bubbles: true }))
      }
    } catch { /* 兜底也失败：静默跳过，文本仍会照常填入 */ }
  }
}

/**
 * 把文本注入输入框。
 * [CONSTRAINT] 每个分支的 dispatchEvent 都不能省：站点靠这些事件同步内部状态，
 *   只改 DOM 值不同步事件，发送按钮会一直保持禁用。
 */
function fillInput(box: HTMLElement, text: string): void {
  if (!box) return

  if (box.tagName === 'TEXTAREA' || box.tagName === 'INPUT') {
    const proto = box.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter) setter.call(box, text)
    else (box as HTMLTextAreaElement).value = text
    box.dispatchEvent(new Event('input', { bubbles: true }))
    box.dispatchEvent(new Event('change', { bubbles: true }))
    return
  }

  if (box.isContentEditable) {
    box.focus()

    // 清空既有内容（含富文本的块结构）
    try {
      const sel = window.getSelection()
      const range = document.createRange()
      range.selectNodeContents(box)
      sel?.removeAllRanges()
      sel?.addRange(range)
      document.execCommand('delete', false, null)
    } catch { /* 选区 API 不可用：后续注入仍会覆盖 */ }

    // 路径 ②：模拟粘贴（Slate 官方识别路径）
    let pasted = false
    try {
      const dt = new DataTransfer()
      dt.setData('text/plain', text)
      const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })
      try { Object.defineProperty(ev, 'clipboardData', { value: dt }) } catch { /* 同上 */ }
      box.dispatchEvent(ev)
      pasted = (box.textContent || '').trim().length > 0
    } catch { /* paste 不可用：落 insertText */ }

    // 路径 ③：insertText
    if (!pasted) {
      try {
        box.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }))
        document.execCommand('insertText', false, text)
        box.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }))
      } catch { /* 两条路径都失败：交由 React 兜底 */ }
    }

    // 补一个普通 input 事件，兼容「能读值但不认 beforeinput」的实现
    try {
      box.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }))
    } catch { box.dispatchEvent(new Event('input', { bubbles: true })) }

    // React 受控组件兜底：合成事件被吞掉时内部 state 仍为空，需再发一次 insertText
    try {
      const isReactBox = Object.keys(box).some(k => k.startsWith('__reactFiber$') || k.startsWith('__reactProps$'))
      if (isReactBox && (box.textContent || '').trim().length === 0) {
        box.focus()
        document.execCommand('insertText', false, text)
        box.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }))
      }
    } catch { /* React 兜底失败不阻断主流程 */ }
  }
}

/**
 * 触发发送并复核「文本是否真的被消费」。
 * [WHY] 点击/回车本身不保证发送成功：按钮可能被禁用、站点可能被频控。
 *   复核判据是「输入框文本消失」——站点发送后必然清空输入框。
 * [CONSTRAINT] onResult 必须在复核结束后才回调：早期实现一发出就 ack(true)，
 *   填字失败/按钮 miss/被频控全都报成功，工作台拿到假回执。
 * @param waitMs 验证窗口；带图时必须显著放宽（上传未完成前按钮是 disabled 的）
 */
function doSend(box: HTMLElement, onResult?: (ok: boolean, reason: string) => void, opts?: { waitMs?: number }): void {
  const waitMs = Math.max(0, Number((opts || {}).waitMs) || 0) || 800
  const done = (ok: boolean, reason: string): void => { if (typeof onResult === 'function') onResult(ok, reason) }
  const tryClick = (): void => {
    const btn = findSendButton(box)
    if (btn) { try { btn.click() } catch { sendEnter(box) } }
    else sendEnter(box)
  }
  tryClick()
  const started = Date.now()
  const check = (): void => {
    const stillHas = ((box.textContent || (box as HTMLTextAreaElement).value || '') as string).trim().length > 0
    if (!stillHas) { done(true, ''); return }
    if (Date.now() - started >= waitMs) {
      console.warn('[ai-runner] 发送可能失败（等待超时）')
      done(false, 'send-verify-failed')
      return
    }
    // 窗口内重试：按钮可能刚恢复可用（例如图片上传完成）
    console.warn('[ai-runner] 文本仍在，重试发送')
    tryClick()
    setTimeout(check, 500)
  }
  setTimeout(check, 400)
}
