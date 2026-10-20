// @ts-nocheck
// [tampermonkey-ts-rewrite-v1] IIFE 物理切分片段，非独立模块；跨片段符号在单文件检查下不可见。
//   全部片段 TS 化完成、按拼回后的联合视图接线后再移除本 pragma。

/**
 * 分类分发 —— 每轮 DOM 稳定后被调用一次，决定「这一轮要推什么」。
 *
 * 三段式，顺序不可随意调换：
 *   ① 门：DONE 稳定门 → 冷启动守卫 → 生成中门。任一命中即 return，不往下走。
 *   ② 探针：stopped → limit。都是「本轮状态相对上一轮/基线」的变化判定。
 *   ③ 分流：script → plain。真正的推送动作。
 *
 * [WHY] 门必须在探针之前：AI 正常生成时正文里可能自指命中停止/触顶词表，
 *   若探针先跑就会误推 stopped，而 stopped 会让前端直接 finish 整个循环。
 */

/**
 * [tm-diag-v1] 回程链路自诊断：**每轮都发**，无论成败。
 *
 * [WHY 需要它] 「脚本零执行」这条故障有三种完全不同的断点，且**都不产生任何错误**：
 *   ① 信封解析不出来（readTurnFromRoot 返 null）——用户看到整坨 JSON 上屏；
 *   ② 解析出来了但 postMessage 送不到工作台（window.opener 为 null / 已closed）——
 *      工作台侧零日志、零报错，只是永远转圈；
 *   ③ 帧送到了但被执行器闸门拦掉。
 *   ①②③ 在服务端日志里长得**一模一样**（runner.jsonl 就是不增长），
 *   所以必须由油猴侧主动把判据报出来，否则只能靠猜（2026-10-19 就在这上面耗了两轮）。
 *
 * [CONSTRAINT] 直发 e.source/opener 而不走 post() 的断链队列：诊断信息在断链时**最需要**送达，
 *   走队列等于在最需要的时候必然丢失。
 * [CONSTRAINT] 只报判据与长度，不报正文（避免把用户内容复制进日志）。
 */
function _tmDiag(stage: string, extra: Record<string, unknown>): void {
  try {
    const opener = window.opener as Window | null
    const payload = {
      type: 'ai-runner:tm-diag',
      stage,
      hasOpener: !!opener,
      openerClosed: !!(opener && opener.closed),
      href: location.href.slice(0, 160),
      ts: Date.now(),
      ...extra,
    }
    // [diag-best-effort] 三条路都试：事件源 → opener → 父窗口
    const targets: Array<Window | null> = [(window as any).__aiDiagSource || null, opener, window.parent]
    for (const t of targets) {
      if (!t) continue
      try { t.postMessage(payload, '*'); return } catch { /* 换下一条路 */ }
    }
  } catch { /* 诊断自身失败不得影响主链路 */ }
}

function classifyAndPost(): void {
  // [tm-diag-v1] 诊断在**门之前**发：opener 缺失导致第19 行早退时，诊断仍能送达，
  //   这正是要抓的那种失败（放在门之后就永远抓不到了）。
  _tmDiag('enter', { hasRoot: typeof latestAssistantRoot === 'function' })

  try {
    if (!window.opener || window.opener.closed) {
      // [tm-diag-v1] 这是最常见的静默断点：直接在地址栏/书签打开的站点页 opener 为 null，
      //   下行靠工作台主动 postMessage 仍然通（只要有窗口引用），上行却全灭。
      _tmDiag('opener-missing', { note: 'classifyAndPost 第一行即return，未做任何分类' })
      return
    }

    // ---------- ① 门 ----------
    // [legacy-done-gate-removed-v1] 旧架构的「首行 DONE」门已删。
    //   [WHY] 契约 §1：每次回复只能是一个 ```json 围栏包住的 turn 信封，围栏外零字符；
    //   任务是否结束由宿主的 `retained-done-gate v1` / `post-done-gate v1` 判定，
    //   SYSTEM.md §1 已明确「turn 总结 ≠ 任务 DONE」——不再由回复里的 DONE 标记派生。
    //   留着它反而会让「总结轮」被当成任务收尾，循环提前结束。

    // 冷启动守卫：首个 fill/rotate 前只记基线，不报「本轮新增」——
    // 历史恢复的存量标记若被当成本轮新增，刷新页面就会立刻误报
    if (!_roundBaselinesReady) {
      limitMarkerBaseline = countLimitMarkers()
      // [turn-coldstart-bypass-v1] 信封是「整轮交付」，不是「本轮新增」的增量判定，
      //   因此不受本守卫约束——守卫期内仍放行信封，其余探针（stopped / limit / plain）维持原样。
      // [WHY 必须放行] 本守卫只在收到过 fill/rotate 后才解除。若那一帧没被本页收到
      //   （用户在 AI 页手动提问 / 工作台的窗口引用指向了另一个窗口），守卫永不解除
      //   ⇒ 油猴零回传、工作台时间线全空白，而服务端日志**零痕迹**（用户实测 2026-10-20）。
      //   守卫的初衷只是防「历史存量标记被当成本轮新增」，信封 JSON 是显式结构化交付，
      //   不存在该误报面，故放行它是零风险的。
      // [CONSTRAINT] 与下方主路径同构：`if (turn && emitTurn(turn)) return` 是
      //   turn-emit-parity 守卫的字面量判据，此处必须逐字相同。
      // [CONSTRAINT] 保留生成中门：流式未结束时读到的信封是半截的，推出去等于交付残缺块。
      if (!stopPosted && !isGenerating()) {
        const coldRoot = latestAssistantRoot()
        const coldTurn = readTurnFromRoot(coldRoot)
        // [WHY 每轮都发] 「守卫期内卡住」在服务端完全不可见，只能靠油猴自己报出来。
        _tmDiag(coldTurn ? 'turn-read-cold' : 'coldstart-hold', {
          turnId: coldTurn ? coldTurn.turnId : undefined,
          blocks: coldTurn ? coldTurn.blocks.length : 0,
          replyRootFound: !!coldRoot,
          note: '冷启动守卫期内：仅信封可交付，其余探针挂起',
        })
        if (coldTurn && emitTurn(coldTurn)) return
      }
      return
    }

    // 生成中门：流式未结束时 script/plain 一律推迟
    const currGen = isGenerating()
    if (currGen) {
      // [stopped-btn-v1] 进入 generating 时记录 roots 计数与最后根身份
    if (!prevGenerating) { genEnterRoots = countAssistantRoots(); genEnterRootId = assistantRootId() }
      setPrevGenerating(currGen)
      // 「生成结束」常非 DOM 事件（按钮变灰/光标移除），若无后续 DOM 变更就再也没人唤醒它
      // [generating-gate-v2] 生成结束常非 DOM 事件：单飞自巡检定时器兜底唤醒
      if (!genRetryTimer) {
        genRetryTimer = setTimeout(() => { genRetryTimer = null; classifyAndPost() }, 600)
      }
      return
    }

    // ---------- ② 探针 ----------

    // stopped：三条判据任一成立即认定平台自停
    //   ① 上一轮在生成 + 本轮按钮消失 + 本轮没产出任何回复块（思考期被停）
    //   ② 「继续生成」按钮存在（[stopped-continue-btn-v1]）
    //   ③ 当前轮回复区出现「已停止」角标（[stopped-label-v1]，无继续按钮时的唯一信号）
    if (prevGenerating && !stopPosted) {
      const rootsNow = countAssistantRoots()
      const rootsFrozen = rootsFrozenNow(genEnterRoots, genEnterRootId, rootsNow, assistantRootId())
      const stoppedByBtn = hasContinueBtn()
      const stoppedByLabel = hasStoppedLabel()
      if (rootsFrozen || stoppedByBtn || stoppedByLabel) {
        stopPosted = true
        lastBodySig = bodySignature()
        const reasonSuffix = stoppedByBtn ? '（继续生成按钮）' : stoppedByLabel ? '（已停止角标）' : ''
        post({
          type: 'ai-runner:reply',
          kind: 'stopped',
          site: location.origin,
          sessionId: extractSidFromHash(),
          text: `${STOPPED_GENERIC}${reasonSuffix}`,
        })
        setPrevGenerating(false)
        return
      }
      // 根增长了 / 最后根身份变了 ⇒ 正常完成或 regenerate，不是中断
      setPrevGenerating(false)
    }

    // limit：两条通道拆开——增长通道自限不 gate；存量兜底不依赖增长，必须 gate
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

    // 结构未闭合的块被延迟后，DOM 若不再变动就再没人叫它，需主动排一次复查。
    // 只在门仍处等待期（ticks < 3）且无在途定时器时排，避免释放后空转
    // [script-closure-gate-v1] 未闭合块被延迟后主动排复查，否则 DOM 静止则无人唤醒
    const closureGate = (window as any).__aiRunnerClosureGate
    if (closureGate && closureGate.ticks < 3 && !closureRetryTimer) {
      closureRetryTimer = setTimeout(() => { closureRetryTimer = null; classifyAndPost() }, 400)
    }

    // ---------- ③ 分流 ----------

    const replyRoot = latestAssistantRoot()
    // [turn-emit-v1] 信封优先（契约 §2.1）：命中即整轮按块交付，**不再**走 script / plain。
    // [WHY] 信封 JSON 在旧路径下的实际下场：语言判定把它归到 json ⇒ 白名单拒绝 ⇒
    //   整条回复降级 plain，用户看到一坨 JSON 且脚本一个都不执行（静默失效）。
    // [CONSTRAINT] 必须先于下面的 turn-invalid 探针：读得出信封即本轮合规，不该再报违规。
    // [CONSTRAINT] stopPosted 后不推：前端已 finish 循环，此时推块等于「循环外自动执行」旁路。
    if (!stopPosted) {
      const turn = readTurnFromRoot(replyRoot)
      // [tm-diag-v1] 诊断读判据；`if (turn && emitTurn(turn)) return` 这一行是
      //   turn-emit-parity 守卫的字面量判据（emitTurn 返回值必须中断分流），**不要改写它**。
      // [turn-read-diag-gate-v1] 诊断帧必须带正文签名门：读判据只依赖正文 ⇒ 同一正文必然同一判据，
      //   而 800ms 空转轮询在正文静止时反复唤醒本函数，不带门就是每 800ms 重发一条一模一样的
      //   turn-miss（用户实测 2026-10-20「一直推送停不下来」）——与 turn-invalid 当年踩的坑同病
      //   （state.ts _invalidReportedSig 的教训）。正文一变门即重开，状态迁移仍逐次可见。
      const readSig = bodySignature()
      if (readSig !== (globalThis as any).__aiTurnReadDiagSig) {
        ;(globalThis as any).__aiTurnReadDiagSig = readSig
        _tmDiag(turn ? 'turn-read' : 'turn-miss', {
          turnId: turn ? turn.turnId : undefined,
          blocks: turn ? turn.blocks.length : 0,
          errors: turn ? (turn.errors || []).length : 0,
          replyRootFound: !!replyRoot,
        })
      }
      if (turn && emitTurn(turn)) return
    }

    // [legacy-marks-removed-v1] 旧标记架构（首行 SCRIPT / ASK / DONE / HANDOFF / TEXT）与
    //   script / plain 两条回传通道已整体删除：契约 §1 规定「裸文本与无围栏代码一律整轮丢弃」。
    //   ⇒ 走到这里即本轮没有可用信封；除下面这条违规回传外，不再做任何推送。

    // [turn-invalid-v1] 有回复正文却读不出信封 ⇒ 回传一次违规帧，让工作台与 AI 都知道原因。
    //   [WHY 必须回传] 丢弃是契约要求的正确行为，但**静默**丢弃会让「AI 写完总结 → 工作台一片空白
    //   → 之后再无任何回传」变成无从下手的悬案：用户分不清是链路断了还是被契约丢了，
    //   而两种成因的处置完全相反（截断须拆小串行重发，裸文本须改用信封重发）。
    // [CONSTRAINT] 只回传判据（错误码 + 字节数 + 首部 80 字），不回传正文（不污染时间线）。
    // [CONSTRAINT] 同一正文签名只回传一次：正文静止时 800ms 空转轮询会反复唤醒本函数。
    if (replyRoot && !stopPosted && !isGenerating()) {
      const invalidSig = bodySignature()
      if (invalidSig !== _invalidReportedSig) {
        const probeMd = extractReplyMd(replyRoot)
        if (String(probeMd || '').trim()) {
          const probe = parseTurn(probeMd)
          const truncated = !!(probe && probe.truncated)
          _invalidReportedSig = invalidSig
          post({
            type: 'ai-runner:turn-invalid',
            code: truncated ? 'TURN_TRUNCATED' : 'TURN_NOT_JSON',
            bytes: String(probeMd || '').length,
            head: String(probeMd || '').slice(0, 80),
            site: location.origin,
            sessionId: extractSidFromHash(),
          })
        }
      }
    }
  } catch { /* 页面导航/关闭期间的 DOM 异常：本轮放弃，下轮自然重试 */ }
}
