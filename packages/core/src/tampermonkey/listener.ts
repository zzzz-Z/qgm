// @ts-nocheck
// [tampermonkey-ts-rewrite-v1] IIFE 物理切分片段，非独立模块；跨片段符号在单文件检查下不可见。
//   全部片段 TS 化完成、按拼回后的联合视图接线后再移除本 pragma。

/**
 * 入站指令处理 —— 工作台通过 postMessage 驱动脚本的唯一入口。
 *
 * 六类指令分两组：
 *   · 带内容的动作（fill / rotate）：重置轮次状态 → 去重 → 注入 → 发送复核 → 回执
 *   · 控制类（new-session / replay / rescan / stop）：不重置状态，各自动作
 *
 * [CONSTRAINT] stop 刻意**不**走 resetRoundState：
 *   停止后必须保留 seenHashes / lastBodySig，否则旧回复会被重判为新回复重新推送。
 * [CONSTRAINT] 所有带 ackId 的指令在每条失败路径上都必须 ackFill(false, ...)，
 *   否则工作台 sendFillToAsync 会一直等到超时（表现为「工作台卡住」）。
 */

/**
 * 入站去重：查 msgId 是否已消费（**不登记**）。
 * [WHY] postMessage 可能因重连重发、多窗口广播而重复到达；
 *   重复执行 fill 会把同一段 prompt 发两遍。
 * [CONSTRAINT] 登记（markSeenInbound）必须延后到「确认可消费」之后：若在到达时就登记，
 *   失败路径（no-input-box / empty-prompt）会烧掉 msgId ⇒ 工作台复用同一 msgId 的重试
 *   会被 dedup-skip 而永远填不进去。延后登记后，「已消费」的重复帧被挡、「未消费」的重试仍可注入。
 * [CONSTRAINT] 集合上限 200，超出后淘汰最早一条 —— 单轮消息量远小于此值，
 *   限制只是防止长时间运行的无界增长。
 */
function isSeenInbound(msgId: string | undefined): boolean {
  return !!msgId && _seenInbound.has(msgId)
}

/** 标记 msgId 已消费（仅在确认可消费后调用；见 handleFill / handleRotate 的顺序约束） */
function markSeenInbound(msgId: string | undefined): void {
  if (!msgId || _seenInbound.has(msgId)) return
  _seenInbound.add(msgId)
  if (_seenInbound.size > 200) _seenInbound.delete(_seenInbound.values().next().value as string)
}

/** 发送后轮询 URL 变化并回传（最多 8 秒）。站点发消息常伴随 URL 跳转到具体会话页 */
function watchUrlChange(prevHref: string, replySrc: MessageEventSource | null): void {
  let urlTries = 0
  const urlPoll = setInterval(() => {
    urlTries += 1
    if (location.href !== prevHref && location.href !== 'about:blank') {
      clearInterval(urlPoll)
      try {
        const target = replySrc || window.opener
        if (target) target.postMessage({ type: 'ai-runner:url-updated', url: location.href, id: extractId() }, '*')
      } catch { /* opener 关闭：跳过 */ }
      return
    }
    if (urlTries > 32) clearInterval(urlPoll)
  }, 250)
}

/**
 * fill：注入 prompt（可带图）并发送。
 * [CONSTRAINT] 带图时验证窗口放宽到 60s：站点上传完成前发送按钮是 disabled 的，
 *   短窗口必然判 send-verify-failed（实测「图片太大时油猴发送失败」）。
 */
function handleFill(d: FillMessage, e: MessageEvent): void {
  resetRoundState()
  if (isSeenInbound(d.msgId)) { ackFill(false, 'dedup-skip', d.ackId); return }

  const prompt = String(d.prompt || '')
  if (!prompt) { ackFill(false, 'empty-prompt', d.ackId); return }
  const box = findInputBox()
  if (!box) { console.warn('[ai-runner] 未找到输入框'); ackFill(false, 'no-input-box', d.ackId); return }
  // [fill-msgid-reuse-v1] 到这里才登记 msgId：上面两条失败路径不烧号，工作台复用同一 msgId 的
  //   重试（no-input-box / 丢帧）仍能真正注入；而「已消费」后的重试（send-verify-failed：
  //   文本已填入、仅发送未确认）被上面的 dedup-skip 挡住，避免同一提问连发两遍。
  markSeenInbound(d.msgId)

  const prevHref = location.href
  const imgs = Array.isArray(d.images) ? d.images : []
  // 图片先于文本注入：上传多为异步，先占位可避免文本覆盖图片区
  if (imgs.length) pasteImages(box, imgs)
  fillInput(box, prompt)
  setTimeout(() => {
    doSend(box, (ok, reason) => ackFill(ok, reason, d.ackId), imgs.length ? { waitMs: 60000 } : undefined)
  }, 300)
  watchUrlChange(prevHref, e.source)
}

/**
 * rotate：注入指令并发送（触顶轮转用）。
 * [CONSTRAINT] 与 fill 的唯一区别是**不**带图、且没有 ackId 回执 —— 轮转由工作台主动发起，
 *   结果通过后续的会话 ID 上报体现，不需要单独回执。
 */
function handleRotate(d: RotateMessage): void {
  resetRoundState()
  if (isSeenInbound(d.msgId)) return

  const instruction = String(d.instruction || '')
  if (!instruction) return
  const box = findInputBox()
  if (!box) { console.warn('[ai-runner] rotate: 未找到输入框'); return }
  markSeenInbound(d.msgId)
  fillInput(box, instruction)
  setTimeout(doSend, 300, box)
}

/**
 * new-session：开新会话并回执。
 * [CONSTRAINT] 成功要等 1.5s 再回执：站点新建会话是异步的，
 *   立刻读 location 会拿到旧 URL，工作台据此记录的会话就是错的。
 */
function handleNewSession(): void {
  const clicked = clickNewSession()
  if (clicked) {
    setTimeout(() => {
      post({ type: 'ai-runner:new-session-created', url: location.href, id: extractId(), sessionId: extractSidFromHash() })
    }, 1500)
  } else {
    // degraded：站点既没有新建按钮、也不在可跳转路径 —— 由工作台决定是否降级处理
    post({ type: 'ai-runner:new-session-created', url: '', id: '', degraded: true, sessionId: extractSidFromHash() })
  }
}

/**
 * request-replay：工作台刷新后请求重放最近的回传。
 * [CONSTRAINT] 必须打 rescan 标记：否则工作台会把历史脚本当「新脚本」走自动执行，
 *   表现为刷新页面就把上一轮的残留脚本重跑一遍。
 */
function handleReplay(): void {
  try {
    for (const m of _msgBuf) {
      if (m && (m.type === 'ai-runner:reply' || m.type === 'ai-runner:session-id')) {
        const mm = m.type === 'ai-runner:reply' ? Object.assign({}, m, { rescan: true }) : m
        if (window.opener && !window.opener.closed) window.opener.postMessage(mm, '*')
      }
    }
  } catch { /* opener 受限：放弃本次重放，下次 request-replay 还会来 */ }
}

/**
 * request-rescan：油猴缓存丢失时从页面重新抓取最新回复。
 * [CONSTRAINT] 脚本与纯文本两条路径都带 rescan 标记，理由同 handleReplay。
 */
function handleRescan(): void {
  try {
    const item = extractLatestScript()
    if (item && item.code) {
      window.opener && window.opener.postMessage({
        type: 'ai-runner:reply', kind: 'script', code: item.code, lang: item.lang,
        hash: item.hash, site: location.origin, sessionId: extractSidFromHash(), rescan: true,
      }, '*')
    } else {
      const txt = extractLatestReplyText()
      if (txt && txt.length > 20) {
        window.opener && window.opener.postMessage({
          type: 'ai-runner:reply', kind: 'plain', text: txt,
          sessionId: extractSidFromHash(), rescan: true,
        }, '*')
      }
    }
    window.opener && window.opener.postMessage({ type: 'ai-runner:session-id', id: extractId(), sessionId: extractSidFromHash() }, '*')
  } catch { /* DOM 已卸载：放弃本次重扫 */ }
}

/**
 * stop：打断生成 + 清运行缓冲 + 摘观察器。
 * [CONSTRAINT] 顺序固定：先诊断回传（此时 DOM 还在，能采到候选按钮），
 *   再点停止，最后才清缓冲与摘观察器 —— 反过来会拿不到诊断数据。
 * [CONSTRAINT] 保留 seenHashes / seenDoneMarkers / lastBodySig：
 *   清空会让旧回复被重判为新回复；下次 fill/rotate 由 resumeReplyObserver 恢复观察。
 */
function handleStop(e: MessageEvent): void {
  let dsIcon: 'hit' | 'miss' | 'na' = 'na'
  try {
    const dsBtn = findStopGeneratingBtnStructural()
    if (dsBtn) dsIcon = hasDeepSeekStopIcon(dsBtn) ? 'hit' : 'miss'
  } catch { /* 诊断异常不影响 stop 主流程 */ }

  try {
    const cands = collectStopCandidates()
    const brief = cands.slice(0, 3).map((el, i) => {
      const tag = el.tagName.toLowerCase()
      const al = el.getAttribute('aria-label') || ''
      const ti = el.getAttribute('title') || ''
      const cl = String(el.getAttribute('class') || '').slice(0, 40)
      const tx = String(el.textContent || '').trim().slice(0, 20)
      return `#${i + 1} <${tag}> aria="${al}" title="${ti}" class="${cl}" text="${tx}"`
    }).join(' | ')
    const src = e.source || window.opener
    if (src) src.postMessage({ type: 'ai-runner:stop-diag', count: cands.length, brief, dsIcon, ver: '1.7.7' }, '*')
  } catch (err) { console.warn('[ai-runner] stop-diag failed', err) }

  const stopHit = clickStopGenerating()
  console.log('[ai-runner] stop received, stop-btn hit =', stopHit)
  // [stop-ack-v1] 停止结果必须回传：前端据 hit 决定 toast 文案
  if (window.opener && !window.opener.closed) window.opener.postMessage({ type: 'ai-runner:stop-ack', hit: stopHit, site: location.origin }, '*')

  _msgBuf.length = 0
  _pending.length = 0
  if (observerDebounce) { clearTimeout(observerDebounce); observerDebounce = null }
  if (closureRetryTimer) { clearTimeout(closureRetryTimer); closureRetryTimer = null }
  if (genRetryTimer) { clearTimeout(genRetryTimer); genRetryTimer = null }
  pauseReplyObserver()
  // [stop-resume-observer-v1] 停止后 1.5s 自动重挂，防 observer 永久断开
  setTimeout(() => { try { resumeReplyObserver() } catch { /* body 未就绪下次再试 */ } }, 1500)
}

/** 主监听器：按 type 分发到各自 handler；未知类型静默忽略（协议向前兼容） */
window.addEventListener('message', (e: MessageEvent) => {
  const d = e.data as InboundMessage | null
  if (!d || typeof d !== 'object') return
  switch (d.type) {
    case 'ai-runner:fill': handleFill(d, e); break
    case 'ai-runner:rotate': handleRotate(d); break
    case 'ai-runner:new-session': handleNewSession(); break
    case 'ai-runner:request-replay': handleReplay(); break
    case 'ai-runner:request-rescan': handleRescan(); break
    case 'ai-runner:stop': handleStop(e); break
    default: break
  }
})
