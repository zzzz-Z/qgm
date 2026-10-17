// ===== fill / rotate / new-session / stop =====
// [stop-v3] 按钮未命中时以 Esc 键盘事件兜底（站点改文案/图标按钮漏配时仍有概率阻断）
// [WHY] 纯文案匹配脆弱：DeepSeek/千问按钮改版即静默失效，AI 继续流式生成
// [CHANGE-IMPACT] 返回值语义不变（true=按钮命中）；stop 分支据此打日志
function clickStopGenerating() {
  try {
    // [stop-btn-deepseek-fallback-v1] 仅在真正需要「停止」时才用结构化兜底：
    //   此刻输入区的圆形主按钮必然是停止键（发送键已让位），不会误伤 generating-gate。
    const btn = findStopGeneratingBtn() || findStopGeneratingBtnStructural()
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
    // [send-btn-widen-v1] 正则与 headless 侧 fillPromptInPage 对齐：
    //   原 /^发送$/ 要求按钮纯文本等于「发送」，真站点按钮为图标 + 变体文案 ⇒ 三步全 miss 退化合成 Enter
    const lbl = [b.getAttribute('aria-label'), b.getAttribute('title'), b.getAttribute('data-testid'), b.textContent].filter(Boolean).join(' ')
    return /发送|send|submit/i.test(lbl)
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

  // [image-paste-dup-fix-v1] 双路径**互斥**：原实现先 paste 再无条件塞 file-input，
  //   两条路径在 DeepSeek 上都会生效 ⇒ 同一张图上传两次（用户实测「一张变两张」）。
  //   [WHY] 判据用「paste 是否真的被站点消费」不可靠（dispatchEvent 无返回值）；
  //     改为：只在 paste 路径**抛异常**时才走 file-input 兜底（异常 = 构造/派发失败）。
  //   [CONSTRAINT] 与 headless-inject 的同名实现保持语义一致（两处刻意同构）。
  let pasted = false
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
    pasted = true
  } catch { /* paste 不被支持：落 file-input 兜底 */ }

  // 兜底：仅当 paste 路径失败时才塞 file input（避免双重上传）
  if (!pasted) {
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

// [send-ack-after-verify-v1] onResult 在复核完成后回调，取代原先 doSend 一返回就 ack：
//   原实现 ackFill(true) 比 doSend 本身还早 300ms ⇒ 填字失败/按钮 miss/被频控都会回 ok:true
// [send-wait-upload-v1] opts.waitMs：验证窗口（默认 800ms，覆盖原 400+400 两次判定）。
// [WHY] 带图发送时站点会把发送按钮置 disabled 直到上传完成，输入框文本在此期间不消失；
//   旧的固定 400ms 窗口必然判 send-verify-failed，客户端把它当「发送失败」弹错
//   （用户报告：图片太大时网页还在解析，油猴发送失败）。
// [CONSTRAINT] 窗口内每 500ms 重试一次点击/Enter（按钮可能刚恢复可用）；文本消失即视为成功。
