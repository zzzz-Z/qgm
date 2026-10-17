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

function classifyAndPost(): void {
  try {
    if (!window.opener || window.opener.closed) return

    // ---------- ① 门 ----------

    const doneMarker = findNewDone()
    if (doneMarker) {
      // DONE 双门：生成中不推（首行可能流式中途出现）+ 2 帧稳定门兜底
      if (isGenerating()) return
      const doneSig = bodySignature()
      if (_pendingDoneSig !== doneSig) {
        _pendingDoneSig = doneSig
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
      lastBodySig = doneSig
      return
    }

    // 冷启动守卫：首个 fill/rotate 前只记基线，不报「本轮新增」——
    // 历史恢复的存量标记若被当成本轮新增，刷新页面就会立刻误报
    if (!_roundBaselinesReady) {
      limitMarkerBaseline = countLimitMarkers()
      return
    }

    // 生成中门：流式未结束时 script/plain 一律推迟
    const currGen = isGenerating()
    if (currGen) {
      if (!prevGenerating) { genEnterRoots = countAssistantRoots(); genEnterRootId = assistantRootId() }
      prevGenerating = currGen
      // 「生成结束」常非 DOM 事件（按钮变灰/光标移除），若无后续 DOM 变更就再也没人唤醒它
      if (!genRetryTimer) {
        genRetryTimer = setTimeout(() => { genRetryTimer = null; classifyAndPost() }, 600)
      }
      return
    }

    // ---------- ② 探针 ----------

    // stopped：上一轮在生成 + 本轮按钮消失 + 本轮没产出任何回复块
    if (prevGenerating && !stopPosted) {
      const rootsNow = countAssistantRoots()
      if (rootsFrozenNow(genEnterRoots, genEnterRootId, rootsNow, assistantRootId())) {
        stopPosted = true
        lastBodySig = bodySignature()
        post({
          type: 'ai-runner:reply',
          kind: 'stopped',
          site: location.origin,
          sessionId: extractSidFromHash(),
          text: STOPPED_GENERIC,
        })
        prevGenerating = false
        return
      }
      // 根增长了 / 最后根身份变了 ⇒ 正常完成或 regenerate，不是中断
      prevGenerating = false
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
    const closureGate = (window as any).__aiRunnerClosureGate
    if (closureGate && closureGate.ticks < 3 && !closureRetryTimer) {
      closureRetryTimer = setTimeout(() => { closureRetryTimer = null; classifyAndPost() }, 400)
    }

    // ---------- ③ 分流 ----------

    const replyRoot = latestAssistantRoot()
    const marks = scanReplyMarks(replyRoot ? extractReplyMd(replyRoot) : '')
    const markedNonScript = marks.ask > 0 || marks.done > 0 || marks.handoff > 0 || marks.text > 0

    // script：标记行为非脚本类时整轮不走脚本分类（否则带示例代码块的 DONE 总结会被当脚本执行）
    // stopped 后残余块一律不推：前端已 finish 循环，此时推出去会形成「循环外自动执行」旁路
    if (!markedNonScript && !stopPosted) {
      const item = extractLatestScript() || extractScriptFromMarkdown()
      if (item && emitScript(item)) {
        // 同一回复里还有未推送的块 ⇒ 主动再跑一次（observer 此时已静止）
        if (hasMoreUnseenBlocks()) setTimeout(classifyAndPost, 80)
        return
      }
    }

    // plain：仅在正文真的变了时推
    const sig = bodySignature()
    if (sig === lastBodySig) return
    lastBodySig = sig

    // 容器缺失 ⇒ 变化来自思考面板/搜索卡的流式抖动，此时整页反推会产出噪音卡
    if (!replyRoot) return
    if (stopPosted) return
    // 首行是 SCRIPT 且脚本已推成功 ⇒ 此处 plain 必为 DOM 抖动引起的重复补发
    if (marks.script > 0 && seenHashes.size > 0) return

    const fence = decideScriptFence(marks.script > 0, seenHashes.size, _scriptFenceReported)
    if (fence === 'report') { emitFenceError(); return }
    if (fence === 'suppress') return

    emitPlain(extractLatestReplyText() || '', marks)
  } catch { /* 页面导航/关闭期间的 DOM 异常：本轮放弃，下轮自然重试 */ }
}
