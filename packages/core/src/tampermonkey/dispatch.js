    const dsBtn = findStopGeneratingBtnStructural()
    return Boolean(dsBtn && !dsBtn.disabled && hasDeepSeekStopIcon(dsBtn))
  }

  let observerDebounce = null
  // [script-closure-gate-v1] 未闭合块被延迟时的单飞复查定时器（见 classifyAndPost）
  let closureRetryTimer = null
  // [generating-gate-v2] 生成期自巡检单飞定时器；声明在 closureRetryTimer 之后，避免 no-use-before-define
  let genRetryTimer = null
  function classifyAndPost() {
    try {
      if (!window.opener || window.opener.closed) return

      const doneMarker = findNewDone()

      if (doneMarker) {
        // [done-gate-v1] DONE 双门：生成中不推（首行可能流式中途出现）+ 2 帧稳定门兜底（与 headless 同构）。
        if (isGenerating()) return
        const _doneSig = bodySignature()
        if (_pendingDoneSig !== _doneSig) {
          _pendingDoneSig = _doneSig
          return
        }
        _pendingDoneSig = null
        seenDoneMarkers.add(doneMarker.marker)
        post({
          type: 'ai-runner:reply',
          kind: 'done',
          site: location.origin,
          sessionId: extractSidFromHash(),
          text: doneMarker.text,
        })
        lastBodySig = _doneSig
        return
      }

      // [stopped-detect-v3] 冷启动守卫（说明见上方声明处）：尚无「本轮」⇒ 只把存量记为基线，不报。
      //   [stopped-btn-v1] 起只覆盖 limit（stopped 按钮驱动、无文本基线）；fill 前同样没有本轮。
      if (!_roundBaselinesReady) {
        limitMarkerBaseline = countLimitMarkers()
        return
      }

      // [generating-gate-v1] 流式输出未完，script/plain 一律等生成结束后再发
      // [generating-gate-v2] 但「生成结束」本身常是非 DOM 事件（停止按钮变灰/消失、生成光标移除），
      //   若无 childList/characterData 变更，原裸 return 会让通道陷入零定时器状态 → 回传卡死，
      //   必须用户滚动/点击制造 DOM 变更才会被唤醒。故排单飞自检：每次到点若仍在生成则再挂一个，
      //   生成一旦结束 → 下次到点放行 classifyAndPost 后自然停挂。seenHashes/lastBodySig 保证不重复推送。
      //   [parity] headless-inject.ts startReplyPoll 以 800ms 轮询天然无此症，本补丁仅对齐回传及时性。
      // [generating-gate-v3] 提到 stopped/limit 探针**之前**：避免 AI 正常生成时正文里自指命中停止/触顶关键词
      //   （2026-10-15 实测：AI 讨论 SiteAdapter 改造时，在正文里复述了"已停止回答"等探针关键词 →
      //   旧顺序下 stopped 探针先扫到 → 误推 stopped → 后续脚本被 stopped-window 闸门拦截）。
      //   真 stopped（用户点停止/服务端中断）会让 isGenerating() 转 false（停止按钮消失/变灰），
      //   generating gate 放行后 stopped 探针仍能正常命中。
      // [stopped-btn-v2] 同时承担按钮状态追踪：进入 generating 时记 roots、保持 prevGenerating 更新，
      //   退出（放行）后 stopped 探针据此判定是中断还是正常 DONE。
      const currGen = isGenerating()
      if (currGen) {
        // [stopped-btn-v2] 刚进入 generating → 同时记 roots 计数与最后根身份（见 rootsFrozenNow）
        if (!prevGenerating) { genEnterRoots = countAssistantRoots(); genEnterRootId = assistantRootId() }
        prevGenerating = currGen // 保持追踪，让下一轮 stopped 探针能感知「按钮从有到无」
        if (!genRetryTimer) {
          genRetryTimer = setTimeout(() => { genRetryTimer = null; classifyAndPost() }, 600)
        }
        return
      }
      // generating gate 放行：同步 prevGenerating → 让下方 stopped 探针能看到「上一轮还在生成」
      // （prevGenerating 在上面的 return 分支里已经保持为 true，此处若 currGen===false 则仍为上一次的 true）
      // 不需要再更新：stopped 探针里用 prevGenerating（上一次的值）和 currGen（本次 false）的组合
      // 就能判定「按钮从有到无」

      // [stopped-btn-v1] 按钮状态驱动的停止检测：
      //   判据：prevGenerating===true（上一轮按钮存在）+ currGen===false（本轮消失）
      //         + rootsFrozenNow（进入生成时的 assistant 根数与最后根身份均未变）
      //   不再扫描正文关键词（2026-10-15 实测：AI 讨论 SiteAdapter 改造时正文自指命中"已停止回答"
      //   → 误推 stopped → 后续脚本被 stopped-window 闸门拦截）。
      //   [WHY] generating gate 已把 currGen=true 的情况 return 掉，能走到这里必然 currGen=false，
      //   所以条件只需 prevGenerating===true（组合起来即「按钮从有到无」）。
      // [stopped-btn-v2] 冻结判据从「计数未增长」收紧为「计数与最后根身份均未变」：
      //   regenerate 原地替换与虚拟列表回收同样计数不变，但最后根身份已变 ⇒ 不再误推。
      // [KNOWN-LIMIT-1] roots 冻结区分不了「正常完成」与「中途停止」，且依赖 assistant 根挂载时序：
      //   · 根随请求/骨架早早挂载的站点：半截中断也判得出（根在进入生成时已计过、不再增长）；
      //   · 根随首 token 才挂载的站点：有部分输出的中断 roots 已增长 ⇒ 漏判（静默放行，
      //     表现为循环不 finish、残余脚本照常执行回传）；
      //   · regenerate 流程 2026-10-16 起由根身份判据排除（旧根替换 ⇒ 身份变化），
      //     不再误推 stopped；但「regenerate 后被停」仍按真停止处理（新根未产出内容）。
      // [KNOWN-LIMIT-2] DeepSeek 的停止/发送按钮无任何可匹配标签（[stop-btn-deepseek-fallback-v1]），
      //   标签通道对它恒 miss；已由 [stop-btn-deepseek-icon-v1] 图签名兜底补上，但锚点是线上 bundle
      //   里的坐标字面量（commit fd5d6ec3 实证）⇒ 站点改版图标后 fail-open 静默退回「该站点
      //   isGenerating() 恒 false」（探针失效但不误报）。失效的观测通道：[stop-diag-v3] 的
      //   dsIcon 字段（stop 诊断回传里直接报 hit/miss）+ 锚点 ratchet 防篡改；若 DeepSeek
      //   回传异常，先看 dsIcon 再核对锚点与线上 bundle。
      if (prevGenerating && !stopPosted) {
        const rootsNow = countAssistantRoots()
        const rootsFrozen = rootsFrozenNow(genEnterRoots, genEnterRootId, rootsNow, assistantRootId())
        if (rootsFrozen) {
          stopPosted = true
          lastBodySig = bodySignature()
          post({
            type: 'ai-runner:reply',
            kind: 'stopped',
            site: location.origin,
            sessionId: extractSidFromHash(),
            text: STOPPED_GENERIC,
          })
          // 消费掉本次状态变化：后续 classifyAndPost 不会再命中此条件（prevGenerating 置 false）
          prevGenerating = false
          return
        }
        // roots 增长了 / 最后根身份变了 → 正常完成（或 regenerate），不是中断；prevGenerating 保持 false
        prevGenerating = false
      }

      // [limit-detect-v2] 会话长度上限感知：触顶后本会话继续提问不可能有产出，
      // 标记计数较 fill/rotate 基线增长即推送 kind:'limit'（更新基线保证只推一次），优先于 script/plain。
      // 存量兜底：fill 时页面已有触顶标记 → 本会话早已触顶；若此后未新增 AI 回复块（重发同样无产出）也推送。
      // 前端收到后触发自动轮转（总结 → 新会话 → 续跑）
      // [limit-posted-v1] 两条触发通道**拆开**处理（旗标语义见上方声明处）：
      //   通道一（计数增长）：基线更新后本轮自然不再成立 ⇒ 自限，**不 gate**；
      //     但仍一并置位 —— 防本轮稍后「存量兜底」再补一枪（同一误报弹两次）。
      //   通道二（存量兜底）：不依赖增长，基线更新压不住 ⇒ **必须 gate**。
      //   [CONSTRAINT] 两者顺序不可换：增长是真信号，优先于存量推断。
      const limitCount = countLimitMarkers()
      if (limitCount > limitMarkerBaseline) {
        limitPosted = true
        limitMarkerBaseline = limitCount
        lastBodySig = bodySignature()
        post({
          type: 'ai-runner:reply',
          kind: 'limit',
          site: location.origin,
          sessionId: extractSidFromHash(),
          text: limitMarkerText || 'AI 会话已达长度上限',
        })
        return
      }
      const limitStale = limitCount > 0 && assistantRootBaseline > 0 && countAssistantRoots() <= assistantRootBaseline
      if (!limitPosted && limitStale) {
        limitPosted = true
        limitMarkerBaseline = limitCount
        lastBodySig = bodySignature()
        post({
          type: 'ai-runner:reply',
          kind: 'limit',
          site: location.origin,
          sessionId: extractSidFromHash(),
          text: limitMarkerText || 'AI 会话已达长度上限',
        })
        return
      }

      // [script-closure-gate-v1] 结构未闭合的块被延迟 ⇒ 主动排一次复查。
      // [WHY] 本通道只由 MutationObserver（350ms 防抖）唤醒，延迟后若 DOM 不再变动就再也没人叫它，
      //   未闭合块会永久滞留。只在门「仍在等待期」（ticks < 3）且无在途定时器时排一次，
      //   避免释放后空转（释放即放行该块，之后 ticks 不再增长，条件自然为假）。
      // （被延迟的另一种可能是上游真截断：此时新一轮分类会在 ticks 达 3 后放行，走既有的 400 补救路径）
      const closureGate = window.__aiRunnerClosureGate
      if (closureGate && closureGate.ticks < 3 && !closureRetryTimer) {
        closureRetryTimer = setTimeout(() => { closureRetryTimer = null; classifyAndPost() }, 400)
      }

      // [reply-mark-v1] 标记行优先：首行是 `ASK` / `DONE` / `HANDOFF` / `TEXT` 的回复不走脚本分类
      //   （否则带示例代码块的 DONE 总结会被当脚本重新执行）；与 headless-inject.ts 同构
      // [no-root-no-reply-v1] 容器缺失 ⇒ 无标记可扫（整页反推会把侧栏标题/用户消息卡混进首行判据）
      const _replyRoot = latestAssistantRoot()
      const marks = scanReplyMarks(_replyRoot ? extractReplyMd(_replyRoot) : '')
      // [stopped-no-autorun-v1] 本轮已推过 stopped ⇒ 剩余脚本块**不再推送**（仅上面的 plain 抑制不够）。
      // [WHY] 前端收到 stopped 会 finish 整个循环（存档 + 清看板 + LoopStop）。此后被中止的那条回复里
      //   若还留着结构闭合的代码块，script 分支仍会把它推出去；循环此时已非活动 ⇒ 前端走
      //   `autoTakeover.scheduleAutoRun`（无条件立即执行）⇒ 形成「循环外自动执行」旁路：
      //   不在任何轮次记账、不进本轮 commit、无自检闸门、无预算反馈（WO-20261005 段三判定为缺陷）。
      //   停止往往来自平台中断/内容截断，残余块大概率是半截代码，执行它不可控。
      // [CONSTRAINT] 与本函数的 plain 抑制同生命周期：stopPosted 随 fill/rotate 重置
      //   （见 [stopped-plain-noise-v1]），新一轮正常脚本不受影响。
      // [parity] headless-inject.ts detectReplyInPage 的 script 分支有同构守卫（dedup._stoppedReported）
      const markedNonScript = marks.ask > 0 || marks.done > 0 || marks.handoff > 0 || marks.text > 0
      // [md-fence-fallback-v1] DOM 提取失败时兜底 Markdown 围栏提取
      const s = (markedNonScript || stopPosted) ? null : (extractLatestScript() || extractScriptFromMarkdown())
      if (s && !seenHashes.has(s.hash)) {
        seenHashes.add(s.hash)
        post({
          type: 'ai-runner:reply',
          kind: 'script',
          code: s.code,
          lang: s.lang,
          hash: s.hash,
          site: location.origin,
          sessionId: extractSidFromHash(),
        })
        lastBodySig = bodySignature()
        // [multi-script-v1] 同一回复里还有未推送的脚本 → 主动再跑一次分类
        // [WHY] 本通道只由 MutationObserver（350ms 防抖）唤醒；推完第一块后 DOM 已静止，
        //   observer 不会再触发，后续块会一直躺着不发
        if (hasMoreUnseenBlocks()) setTimeout(classifyAndPost, 80)
        return
      }

      const sig = bodySignature()
      if (sig !== lastBodySig) {
        lastBodySig = sig
        // [no-root-no-reply-v1] 页面还没有 assistant 回复容器 ⇒ 此时 bodySignature 的变化来自
        //   「已思考」面板/搜索卡片的流式抖动，而 extractLatestReplyText 会整页反推
        //   ⇒ 新会话首轮思考期间，思考面板每稳定一拍就推一张「侧栏标题连体 + SYSTEM.md 卡」
        //   的噪音文本卡（2026-10-08 18:53:19 / 18:53:21 两张卡实测）。
        //   直接不回传：等真实回复容器挂载后 sig 再变化，自然重新进入本分支。
        if (!_replyRoot) return
        // [stopped-plain-noise-v1] 本轮已推过 stopped ⇒ 之后的 plain 必为「已停止」半截回复的补发，跳过。
        // [WHY] stopped 分支只推一次（stopPosted 置位），而停止横幅插入/操作按钮态变化仍会驱动
        //   MutationObserver → bodySignature 变化 → plain 分支把这条半截回复的 DOM→Markdown
        //   反推全文（含流水式长段总结 + 残缺列表）整卡补发 ⇒ 前端时间线多出一张巨大 AI 文本卡
        //   （2026-10-08 截图实测）。[script-plain-noise-v1] 的 marks.script 守卫拦不住它：
        //   半截回复首行是普通文本，不是标记行。
        // [CONSTRAINT] 轮次语义：stopPosted 随 fill/rotate 重置（与 [stopped-btn-v1] 的
        //   prevGenerating/genEnterRoots 重置同点），新一轮的真实 plain 回复不受影响。
        // [parity] headless-inject.ts detectReplyInPage 的 plain 分支有同构守卫（dedup._stoppedReported）
        if (stopPosted) return
        // [script-plain-noise-v1] 首行 = SCRIPT 且本会话已成功推过脚本 ⇒ 此处 post plain 必为噪音，跳过。
        // [WHY] 按输出契约，`SCRIPT` 首行的回复「第二行起是脚本代码块、代码块外零字符溢出」，没有可供展示的正文。
        //   脚本块早已各自经上面的 script 分支推送；此后的 DOM 抖动（流式光标移除 / 操作条·复制按钮晚挂载 /
        //   代码高亮重渲染）会让 bodySignature 变化，plain 分支就把整条回复的 DOM→Markdown 反推全文
        //   （N 个裸 `SCRIPT` 标记行 + 已推送过的围栏）再补发一次 ⇒ 前端多出一张正文只有「SCRIPT」的文本卡。
        //   抖动几次就补发几条 —— 截图里的两张噪音卡 = 两次波动。
        // [CONSTRAINT] 要求 seenHashes.size > 0（脚本确实推出去过）才跳过：脚本从未推成功时
        //   保留旧的 plain 行为，避免「AI 说了话但应用端毫无反应」的静默失败变得不可观测。
        // [parity] headless-inject.ts 的 detectReplyInPage 有同构守卫
        if (marks.script > 0 && seenHashes.size > 0) return
        // [script-fence-gate-v1] 同构守卫（[parity] headless-inject.ts detectReplyInPage）
        // classifyAndPost 开头已 isGenerating() return ⇒ 进入此处即生成结束，不会流式中途误报
        const _fence = decideScriptFence(marks.script > 0, seenHashes.size, _scriptFenceReported)
        if (_fence === 'report') {
          _scriptFenceReported = true
          post({ type: 'ai-runner:reply', kind: 'error', site: location.origin, sessionId: extractSidFromHash(), text: 'SCRIPT 载荷不是有效的 js/cjs 代码块：必须用 ```js 围栏包裹代码，且脚本头用 // @desc / // @why（参考 packages/core/SYSTEM.md §1 状态 A）。' })
          return
        }
        if (_fence === 'suppress') return
        // [ask-text-v1] 补 text：前端 parseAsk 依赖此字段识别交互提问
        // [text-mark-v1] TEXT 标记：剥掉标记行只留正文（extractLatestReplyText 含「TEXT」首行）
        // [CONSTRAINT] extractLatestReplyText 返回最后 assistant 容器文本；缺失时前端退化为纯提示
        const replyMd = (() => { try { return extractLatestReplyText() || '' } catch { return '' } })()
        const replyText = marks.text > 0 ? replyMd.split(/\r?\n/).slice(marks.text).join('\n').trim() : replyMd
        post({
          type: 'ai-runner:reply',
          kind: 'plain',
          site: location.origin,
          sessionId: extractSidFromHash(),
          text: replyText,
        })
      }
    } catch {}
  }
