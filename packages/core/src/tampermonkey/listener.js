  function doSend(box, onResult, opts) {
    const waitMs = Math.max(0, Number((opts || {}).waitMs) || 0) || 800
    const done = (ok, reason) => { if (typeof onResult === 'function') onResult(ok, reason) }
    const tryClick = () => {
      const btn = findSendButton(box)
      if (btn) { try { btn.click() } catch (e) { sendEnter(box) } }
      else { sendEnter(box)
      }
    }
    tryClick()
    const started = Date.now()
    const check = () => {
      const stillHas = (box.textContent || box.value || '').trim().length > 0
      if (!stillHas) { done(true, ''); return }
      if (Date.now() - started >= waitMs) {
        console.warn('[ai-runner] 发送可能失败（等待超时）')
        done(false, 'send-verify-failed')
        return
      }
      console.warn('[ai-runner] 文本仍在，重试发送')
      tryClick()
      setTimeout(check, 500)
    }
    setTimeout(check, 400)
  }

  window.addEventListener('message', (e) => {
    const d = e.data
    if (!d || typeof d !== 'object') return

    if (d.type === 'ai-runner:fill') {
      resumeReplyObserver() // [stop-v2] stop 后首次 fill 恢复回复监听
      _roundBaselinesReady = true // [stopped-detect-v3] 自此冷启动守卫永久失效（本轮语义成立）
      stopPosted = false // [stopped-plain-noise-v1] 开新一轮：解除 plain 补发抑制
      prevGenerating = false // [stopped-btn-v1] 开新一轮：重置按钮状态追踪
      genEnterRoots = 0 // [stopped-btn-v1] 开新一轮：重置进入 generating 时的 roots 基线
      genEnterRootId = '' // [stopped-btn-v2] 开新一轮：重置进入 generating 时的最后根身份
      limitPosted = false // [limit-posted-v1] 开新一轮：解除触顶推送锁定（本轮允许再报一次）
      _scriptFenceReported = false // [script-fence-gate-v1] 开新一轮：重置 fence 报错去重
      syncLimitMarkerBaseline() // [limit-detect-v1] 开新一轮：以当前「上限」计数为新基线
      // [script-closure-gate-v1] 结构闭合门随轮次重置：上一轮遗留的门会拿旧长度当基线，
      //   让新回复第一帧就被判定为「已静止」→ 未闭合块提前放行（门本身见 headless-inject.ts）
      window.__aiRunnerClosureGate = null
      if (genRetryTimer) { clearTimeout(genRetryTimer); genRetryTimer = null } // [generating-gate-v2] 开新一轮清自检
      if (d.msgId && _seenInbound.has(d.msgId)) { ackFill(false, 'dedup-skip', d.ackId); return }
      if (d.msgId) { _seenInbound.add(d.msgId); if (_seenInbound.size > 200) _seenInbound.delete(_seenInbound.values().next().value) }
      const prompt = String(d.prompt || '')
      if (!prompt) { ackFill(false, 'empty-prompt', d.ackId); return }
      const box = findInputBox()
      if (!box) { console.warn('[ai-runner] 未找到输入框'); ackFill(false, 'no-input-box', d.ackId); return }
      const prevHref = location.href
      const replySrc = e.source
      // [image-paste-v2] 图片先于文本注入：图片上传多为异步，先占位可避免文本覆盖图片区
      // [CONSTRAINT] images 缺省或非数组时短路，保持旧行为（无图片路径零变化）
      // [CHANGE-IMPACT] 消费 FillPayload.images（v3 通道）；缺 images 字段时行为不变
      const imgs = Array.isArray(d.images) ? d.images : []
      if (imgs.length) pasteImages(box, imgs)
      fillInput(box, prompt)
      // [send-ack-after-verify-v1] 复核完成后再 ack：工作台 sendFillToAsync 据此判定「已注入」
      // [send-wait-upload-v1] 带图时给上传留 60s 窗口：站点按钮在上传完成前是 disabled 的，
      //   短窗口会把「正在上传」误判成「发送失败」（用户报告）。
      setTimeout(() => { doSend(box, (ok, reason) => ackFill(ok, reason, d.ackId), imgs.length ? { waitMs: 60000 } : undefined) }, 300)
      // [url-updated] 发送后轮询 URL 变化并回传（最多 8s）
      let urlTries = 0
      const urlPoll = setInterval(() => {
        urlTries += 1
        if (location.href !== prevHref && location.href !== 'about:blank') {
          clearInterval(urlPoll)
          const payload = { type: 'ai-runner:url-updated', url: location.href, id: extractId() }
          try {
            const target = replySrc || window.opener
            if (target) target.postMessage(payload, '*')
          } catch { /* ignore */ }
          return
        }
        if (urlTries > 32) clearInterval(urlPoll)
      }, 250)
      return
    }

    if (d.type === 'ai-runner:rotate') {
      resumeReplyObserver() // [stop-v2] stop 后首次 rotate 恢复回复监听
      _roundBaselinesReady = true // [stopped-detect-v3] 自此冷启动守卫永久失效（本轮语义成立）
      stopPosted = false // [stopped-plain-noise-v1] 开新一轮：解除 plain 补发抑制
      prevGenerating = false // [stopped-btn-v1] 开新一轮：重置按钮状态追踪
      genEnterRoots = 0 // [stopped-btn-v1] 开新一轮：重置进入 generating 时的 roots 基线
      genEnterRootId = '' // [stopped-btn-v2] 开新一轮：重置进入 generating 时的最后根身份
      limitPosted = false // [limit-posted-v1] 开新一轮：解除触顶推送锁定（本轮允许再报一次）
      _scriptFenceReported = false // [script-fence-gate-v1] 开新一轮：重置 fence 报错去重
      syncLimitMarkerBaseline() // [limit-detect-v1] 开新一轮：以当前「上限」计数为新基线
      // [script-closure-gate-v1] 结构闭合门随轮次重置：上一轮遗留的门会拿旧长度当基线，
      //   让新回复第一帧就被判定为「已静止」→ 未闭合块提前放行（门本身见 headless-inject.ts）
      window.__aiRunnerClosureGate = null
      if (genRetryTimer) { clearTimeout(genRetryTimer); genRetryTimer = null } // [generating-gate-v2] 开新一轮清自检
      if (d.msgId && _seenInbound.has(d.msgId)) return
      if (d.msgId) { _seenInbound.add(d.msgId); if (_seenInbound.size > 200) _seenInbound.delete(_seenInbound.values().next().value) }
      const instruction = String(d.instruction || '')
      if (!instruction) return
      const box = findInputBox()
      if (!box) { console.warn('[ai-runner] rotate: 未找到输入框'); return }
      fillInput(box, instruction)
      setTimeout(doSend, 300, box)
      return
    }

    if (d.type === 'ai-runner:new-session') {
      // [no-summary-v1] 不再搬运 summary；仅切换会话并回执
      const clicked = clickNewSession()
      if (clicked) {
        setTimeout(() => {
          post({ type: 'ai-runner:new-session-created', url: location.href, id: extractId(), sessionId: extractSidFromHash() })
        }, 1500)
      } else {
        post({ type: 'ai-runner:new-session-created', url: '', id: '', degraded: true, sessionId: extractSidFromHash() })
      }
      return
    }

    if (d.type === 'ai-runner:request-replay') {
      // [replay] 工作台刷新后请求重发最近消息
      try {
        for (const m of _msgBuf) {
          if (m && (m.type === 'ai-runner:reply' || m.type === 'ai-runner:session-id')) {
            // [replay-no-autorun-v1] 重放的是历史消息，须打 rescan 标记：
            //   否则工作台把它当「新脚本」走自动执行，刷新即重跑残留脚本。
            const mm = m.type === 'ai-runner:reply' ? Object.assign({}, m, { rescan: true }) : m
            if (window.opener && !window.opener.closed) window.opener.postMessage(mm, '*')
          }
        }
      } catch { /* ignore */ }
      return
    }

    if (d.type === 'ai-runner:request-rescan') {
      // [rescan] 重扫 DOM：即便油猴缓存丢失，也从页面重新抓取最新回复
      try {
        const s2 = extractLatestScript()
        if (s2 && s2.code) {
          window.opener && window.opener.postMessage({
            type: 'ai-runner:reply',
            kind: 'script',
            code: s2.code,
            lang: s2.lang,
            hash: s2.hash,
            site: location.origin,
            sessionId: extractSidFromHash(),
            rescan: true,
          }, '*')
        } else {
          const txt = extractLatestReplyText()
          if (txt && txt.length > 20) {
            window.opener && window.opener.postMessage({
              type: 'ai-runner:reply',
              kind: 'plain',
              text: txt,
              sessionId: extractSidFromHash(),
              rescan: true,
            }, '*')
          }
        }
        window.opener && window.opener.postMessage({ type: 'ai-runner:session-id', id: extractId(), sessionId: extractSidFromHash() }, '*')
      } catch { /* ignore */ }
      return
    }
    if (d.type === 'ai-runner:stop') {
      // [stop-diag-v2] 诊断回传：无真实 DOM 时用它替代盲猜——
      //   把候选按钮的数量与前 3 个的标签/属性摘要回传工作台。
      // [stop-diag-v3] 追加 dsIcon：DeepSeek 图签名兜底（[stop-btn-deepseek-icon-v1]）的探针状态。
      //   'hit'=圆钮内 svg path 命中停止方块锚点；'miss'=圆钮在但两锚点都未命中（站点改版 ⇒
      //   该兜底已失效，isGenerating() 对该站点恒 false）；'na'=无圆钮可判。
      //   [WHY] 锚点失配是静默 fail-open，无任何运行态信号；stop 诊断是操作员唯一会看的口径，
      //   把 dsIcon 挂在这里让「锚点失效」从不可观测变成一看便知。
      let dsIcon = 'na'
      try {
        const dsBtn = findStopGeneratingBtnStructural()
        if (dsBtn) dsIcon = hasDeepSeekStopIcon(dsBtn) ? 'hit' : 'miss'
      } catch { /* fail-open: 诊断异常不影响 stop 主流程 */ }
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
        const src = (typeof e !== 'undefined' && e.source) || window.opener
        if (src) src.postMessage({ type: 'ai-runner:stop-diag', count: cands.length, brief, dsIcon, ver: '1.7.7' }, '*')
      } catch (err) { console.warn('[ai-runner] stop-diag failed', err) }
      // [stop-v2] 清缓冲 + 保留去重集 + disconnect
      // [WHY] replyObserver 常驻 body；清空 seenHashes/lastBodySig 会让旧回复被重判为新回复 post
      // [CONSTRAINT] 保留 seenHashes / seenDoneMarkers / lastBodySig；下次 fill/rotate 由 resumeReplyObserver 恢复
      // [CHANGE-IMPACT] 与 resumeReplyObserver 成对；改此处必须同步改 resume 触发点
      const stopHit = clickStopGenerating()
      console.log('[ai-runner] stop received, stop-btn hit =', stopHit)
      _msgBuf.length = 0
      _pending.length = 0
      if (observerDebounce) { clearTimeout(observerDebounce); observerDebounce = null }
      if (closureRetryTimer) { clearTimeout(closureRetryTimer); closureRetryTimer = null }
      if (genRetryTimer) { clearTimeout(genRetryTimer); genRetryTimer = null } // [generating-gate-v2] 防跨轮泄漏
      try { replyObserver.disconnect() } catch { /* ignore */ }
      _replyObserving = false
    }
  })
})()
