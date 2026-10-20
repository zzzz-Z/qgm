/* eslint-disable ts/ban-ts-comment -- 需禁用整文件类型检查 */
// @ts-nocheck

// 浏览器上下文 DOM 逻辑：这些函数通过 page.evaluate 序列化后传入浏览器执行。
// Node 侧 tsconfig 无 DOM lib，故此文件豁免类型检查（函数体运行环境有完整 DOM）。
// 从 scripts/tampermonkey-session-id.user.js 移植（findInputBox / fillInput / findSendButton / sendEnter / clickStopGenerating / clickNewSession）。
// 约束：纯函数、无外部闭包引用 —— 序列化后代码结构必须完整。

// [headless-fill-wired-v1] 6 个短函数已抽到 headless-fill.ts

export {
  clickNewSessionInPage,
  collectStopCandidatesInPage,
  detectLoginStateInPage,
  fillPromptInPage,
  pasteImagesInPage,
  resetReplyDedupInPage,
  stopGeneratingInPage,
  verifyFillSentInPage,
} from './headless-fill.js'

/**
 * [headless-collector-v1] 幂等重装页面侧三通道 observer。
 * [WHY] 导航 / 新会话会重建 document，旧 observer 随旧 document 一起失效；
 *   无头侧 waitForSignal 依赖 _bodyVersion 变化来提前唤醒，observer 失效后
 *   只能退化为等满 800ms 上限（不会静默丢回复，但采集延迟回到旧水平）。
 * [CONSTRAINT] 必须幂等：已就绪直接返回，不重复 observe（重复 observe 同一节点会叠加回调）。
 * @returns {boolean} 重装后是否就绪
 */
export function ensureCollectorInPage() {
  const w = window
  if (!w.__aiRunnerDedup) {
    // [legacy-plain-removed-v1] 已删 seenDoneMarkers / _pendingDoneSig（DONE 门）与
    //   _plainSentInCycle / _shortSentHash / _askSentHash（plain 交付链路）。
    //   新增 _hitTurnMiss / _hitTurnDup 承接「这一拍为什么没交付」的诊断 —— 旧的那一组
    //   hits 计数（_hitShortGate / _hitPlainSent / _hitAskDup …）随旧路径删除后再无写入方，
    //   留着会让 poll-miss 日志看起来「一切正常」（这正是 2026-10-20 排查时最耗时的形态）。
    w.__aiRunnerDedup = { seenHashes: [], lastBodySig: '', _pendingScriptHash: null, _hitTurnMiss: 0, _hitTurnDup: 0 }
  }
  const dedup = w.__aiRunnerDedup
  if (dedup._collectorReady && dedup._observer && document.body) return true
  try {
    if (dedup._observer && typeof dedup._observer.disconnect === 'function') dedup._observer.disconnect()
    const obs = new MutationObserver(() => {
      dedup._bodyVersion = (typeof dedup._bodyVersion === 'number' ? dedup._bodyVersion : 0) + 1
      dedup._lastMutationAt = Date.now()
    })
    obs.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true })
    dedup._observer = obs
    dedup._observerInstalled = true
    dedup._collectorReady = true
    dedup._lastMutationAt = Date.now()
    if (typeof dedup._bodyVersion !== 'number') dedup._bodyVersion = 0
    return true
  } catch {
    dedup._collectorReady = false
    return false
  }
}

/**
 * 检测 Reply In Page
 */
export function detectReplyInPage(siteCfg = {}) {
  const w = window
  if (!w.__aiRunnerDedup) {
    // [legacy-plain-removed-v1] 已删 seenDoneMarkers / _pendingDoneSig（DONE 门）与
    //   _plainSentInCycle / _shortSentHash / _askSentHash（plain 交付链路）。
    //   新增 _hitTurnMiss / _hitTurnDup 承接「这一拍为什么没交付」的诊断 —— 旧的那一组
    //   hits 计数（_hitShortGate / _hitPlainSent / _hitAskDup …）随旧路径删除后再无写入方，
    //   留着会让 poll-miss 日志看起来「一切正常」（这正是 2026-10-20 排查时最耗时的形态）。
    w.__aiRunnerDedup = { seenHashes: [], lastBodySig: '', _pendingScriptHash: null, _hitTurnMiss: 0, _hitTurnDup: 0 } // [fix-reply-dedup] [fix-plain-once] [short-reply-gate-v1]
  }
  const dedup = w.__aiRunnerDedup

  // [limit-scan-strip-v1] 触顶/停止/busy/频控四类标记探针只扫「正文」：剥掉代码块、输入框与可编辑区。
  // [WHY] 工作台把脚本 stdout 用 ``` 围栏回填进会话（prompt-builder appendRawOutputs）⇒ 页面里落成
  //   <pre><code>，而源码/文档里含探针自己的词表（如本目录 headless-fill.ts 的
  //   `maximum context length`）⇒ 整页 textContent 自指命中，误报「已达长度上限」并掐掉一整轮
  //   （2026-10-10 12:02 实测；复现脚本 .ai-runner/tmp/limit-fp-repro.cjs，剥壳后 1 → 0）。
  // [CONSTRAINT] 实现体与 headless-fill.ts、scripts/tampermonkey-session-id.user.js 两处
  //   逐字符同构（守卫测试 limit-marker-guard 的 body-text parity 用例）。
  // [CONSTRAINT] **篇幅/增长类**读取点（bodySignature / stillStreamingReply）不得改走本函数——
  //   代码块属于回复正文，剥掉会让「正文是否仍在增长」的判据失真。
  function bodyText() {
    const b = document.body
    if (!b) return ''
    const c = b.cloneNode(true)
    const kill = c.querySelectorAll('pre,code,textarea,input,[contenteditable="true"],script,style')
    for (let i = 0; i < kill.length; i++) kill[i].remove()
    return c.textContent || ''
  }
  // 四类探针共用一份剥壳快照：先用整页 raw 做失效判据（字符串比较，零额外节点分配），
  // 仅在 raw 变化时剥壳一次 ⇒ 页面文本未变时零 clone（常态零额外开销）。
  const scanRaw = (document.body && document.body.textContent) || ''
  if (dedup._scanRaw !== scanRaw) {
    dedup._scanRaw = scanRaw
    dedup._scanText = bodyText()
  }
  const scanText = dedup._scanText
  // [busy-scope-v1] busy/rate 文案只能来自「最后一条 assistant 气泡」，不能扫全页：
  //   历史对话里残留的旧「服务器繁忙」会被全页扫描命中并当成**本轮**错误（实测误报，
  //   真实网页上并无任何限流提示）。这里单独取最后一条气泡的文本作为告警扫描域。
  const _lastAsstEl = document.querySelectorAll('.ds-assistant-message-main-content')
  const alertText = _lastAsstEl.length
    ? String(_lastAsstEl[_lastAsstEl.length - 1].textContent || '')
    : ''

  // body version + hash 缓存，避免每次 poll 重算
  if (typeof dedup._bodyVersion !== 'number') dedup._bodyVersion = 0
  if (!dedup._sigCache) dedup._sigCache = { version: -1, sig: '' }
  if (!dedup._preCache) dedup._preCache = new WeakMap()
  // [legacy-plain-removed-v1] _seenGrowth / _stableCount 随 plain 交付链路一并删除：
  //   「连续 N 拍 body 不变才算生成结束」是为文本交付服务的稳定门槛，
  //   信封靠围栏闭合判定（readTurnBlocks 解析成功即完整），不需要拍数补偿。
  if (typeof dedup._lastMutationAt !== 'number') dedup._lastMutationAt = 0
  if (typeof dedup._collectorReady !== 'boolean') dedup._collectorReady = false
  // [script-closure-gate-v1] 结构闭合门的挂点（见 extractLatestScript）：跨轮不残留，
  //   依赖 stillStreamingReply 的「正文长度变化即重置」自愈，这里只保证键存在
  if (typeof w.__aiRunnerClosureGate === 'undefined') w.__aiRunnerClosureGate = null
  // [stopped-detect-v2] 关键词 stopped 探针（含冷启动基线 _stoppedBaseline）已于 2026-10-16
  //   整体移除：那三个关键词（当前问题已停止|已停止生成|已停止回答）经线上 bundle 实证
  //   （main.a0ce88b684.js，commit fd5d6ec3）在 DeepSeek 真实角标文案里零命中（实际是
  //   已停止/思考已停止/搜索已停止）⇒ 只剩 AI 正文自指的假阳性通道。现行判据见下方
  //   [stopped-btn-v1]（按钮状态驱动，与油猴 [stopped-btn-v1]/[stopped-btn-v2] parity）。
  //   勿复活关键词匹配。
  if (typeof dedup._limitBaseline !== 'number') dedup._limitBaseline = 0 // [limit-detect-v1]
  if (typeof dedup._rateBaseline !== 'number') dedup._rateBaseline = 0 // [rate-retry-v1]
  // [headless-collector-v1] 三通道唤醒：childList / characterData / attributes。
  // [WHY] 原实现只有 childList+characterData（无 attributes），且只记 _bodyVersion 计数；
  //   Node 侧 tick 是 800ms 盲轮询，靠「连续 3 拍相同」反推稳定 ⇒ 2.4s 采集延迟。
  //   与油猴的 observer 模型对齐后，Node 侧可改为「信号驱动 + 静默窗」，延迟降到 400-600ms。
  // [CONSTRAINT] ready 必须在 observer 成功 observe 后置 true；失效（导航 / 页面重建）时
  //   由 Node 侧 fillPrompt 前置检查兜底重装，否则回复会静默丢（本项目最贵的一类 bug）。
  if (!dedup._observerInstalled) {
    dedup._observerInstalled = true
    try {
      const obs = new MutationObserver(() => {
        dedup._bodyVersion++
        dedup._lastMutationAt = Date.now()
      })
      obs.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true })
      dedup._observer = obs
      dedup._collectorReady = true
      dedup._lastMutationAt = Date.now()
    } catch { /* swallow: document.body 未就绪 / Observer 不支持，dedup 退化为纯计数 */ }
  }

  function hash32(input) {
    let h = 0x811C9DC5
    for (let i = 0; i < input.length; i++) {
      h = Math.imul(h ^ input.charCodeAt(i), 0x1000193) >>> 0
    }
    return (h >>> 0).toString(16).padStart(8, '0')
  }

  // [dedup-baseline-v1] 基线守卫：reset 后未新增 assistant 消息节点前，不做任何回复分类
  // [WHY] fill 点发送后旧回复仍挂在页尾（ASK 场景最后一条 assistant 消息就是旧问题），
  //       清空式 dedup 重置会让首轮 poll 把旧 ASK 当新回复重推 → 弹窗死循环，且挤掉真正的新回复
  // [CONSTRAINT] DeepSeek 每轮回复新增独立消息节点，blocks.length 增长即新回复到达；
  //              _baselineBlocks 仅由 resetReplyDedupInPage 写入，未 reset 时 undefined 不拦截
  const _baseBlocks = document.querySelectorAll('.ds-assistant-message-main-content')

  if (!dedup._busyErrorReported) {
    const busyMessages = alertText.match(/server busy, please try again later\.?|(?:服务器|服务)繁忙[^\n。！!]*[。！!]?/gi) || []
    const busyBaseline = typeof dedup._busyErrorBaseline === 'number' ? dedup._busyErrorBaseline : 0
    if (busyMessages.length > busyBaseline) {
      dedup._busyErrorReported = true
      return { kind: 'error', text: busyMessages[busyMessages.length - 1] }
    }
  }

  // [rate-retry-v1] 频控感知：发送被站点「消息发送过于频繁」拒收时本轮不可能有回复，
  // 立即推 error 让前端 toast 告知原因（复用 busy 通道），而不是干等 90s/180s 超时。
  // [CONSTRAINT] 按出现次数 + 基线去重：历史消息里的旧频控文案不触发；本轮只推一次；
  //              正则与 headless-fill.ts 的 verifyFillSentInPage / resetReplyDedupInPage 两处内联同构
  //              （守卫测试 rate-marker-guard.node-test.ts）
  if (!dedup._rateReported) {
    const rateMessages = alertText.match(/(?:消息|发送|操作|请求|访问)过于频繁|过于频繁[，,\s]*请稍后重试|please\s+slow\s+down|too\s+many\s+requests|rate\s+limit/gi) || []
    const rateBaseline = typeof dedup._rateBaseline === 'number' ? dedup._rateBaseline : 0
    if (rateMessages.length > rateBaseline) {
      dedup._rateReported = true
      return { kind: 'error', text: rateMessages[rateMessages.length - 1] }
    }
  }

  // [stopped-btn-v1] 按钮状态探针（parity：scripts/tampermonkey-session-id.user.js [stopped-btn-v1]
  //   的 collectStopCandidates 输入区收敛 + findStopGeneratingBtn + findStopGeneratingBtnStructural
  //   + hasDeepSeekStopIcon 图签名兜底，两级判定同构）。
  // [CONSTRAINT] 必须内联在 detectReplyInPage 内部：本函数经 page.evaluate 序列化到浏览器执行，
  //   顶层引用会随模块边界丢失（同 decideScriptFence，2026-10-14 实测 ReferenceError）。
  // [CONSTRAINT] 与油猴侧逐语同构；改一侧必须同步另一侧（守卫 stopped-btn-guard 的 parity 段）。
  function isGeneratingInPage() {
    const STOP_LABEL_RE = /停止生成|停止回答|停止输出|终止|取消生成|停止|中断|暂停生成|stop\s*generat|stop\s*stream|stop\s*response|stop\s*answer|stop\s*cancel|\bcancel\b|\babort\b|\binterrupt\b|\bhalt\b/i
    const sel = 'button, div[role], span[role], a[role], [role="switch"], [role="menuitem"]'
    const circleSel = '[role="button"].ds-button--circle, button.ds-button--circle'
    // [stop-btn-deepseek-icon-v1] 停止方块图签名锚点（与油猴 DS_STOP_ICON_ANCHORS 同值）
    const dsAnchors = ['M2 4.88C2 3.68009', 'V11.12C14 12.3199']
    function findInputBox() {
      const qwen = document.querySelector('div[contenteditable="true"][role="textbox"]')
      if (qwen) return qwen
      const ta = document.querySelector('textarea:not([readonly]):not([disabled])')
      if (ta) return ta
      return document.querySelector('[contenteditable="true"]') || null
    }
    // 标签通道：只搜输入区（[stop-btn-scope-v1]，scope 解析与油猴 collectStopCandidates 一致：
    //   从 parentElement 起 closest，不用 input.closest——输入框自身 class 含 input 会命中自己）
    const box = findInputBox()
    let scope = document
    const pe = box ? box.parentElement : null
    if (pe) {
      scope = pe.closest('form, [class*="input"], [class*="composer"], [class*="chat-input"], [class*="input-area"], [class*="input-box"], [class*="input_wrap"], [class*="chat-foot"], [class*="dialog-footer"]') || pe
    }
    for (const el of scope.querySelectorAll(sel)) {
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue
      const lbl = [
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.getAttribute('data-testid'),
        el.getAttribute('data-state'),
        el.getAttribute('class'),
        el.textContent,
      ].filter(Boolean).join(' ')
      if (STOP_LABEL_RE.test(lbl)) return true
    }
    // [site-generating-selector-v1] 站点专属生成中信号（智谱 .searching 类）：与 DeepSeek 图签名通道隔离，
    //   仅当适配器显式声明 generatingSelector 时生效，未声明的站点（DeepSeek 等）行为零变化
    if (siteCfg && siteCfg.generatingSelector && document.querySelector(siteCfg.generatingSelector)) return true
    // [generating-gate-v3] 全文档兜底：智谱等站点的停止按钮可能不在输入框 scope 内，导致漏判生成中
    if (!box || scope !== document) {
      const docBtns = document.querySelectorAll('button, div[role="button"], span[role="button"]')
      for (const el of docBtns) {
        if (el.offsetParent === null) continue
        const txt = (el.getAttribute('aria-label') || '') + (el.getAttribute('title') || '') + (el.textContent || '')
        if (/停止生成|停止回答|停止输出/.test(txt)) return true
      }
    }
    // DeepSeek 圆形按钮无标签 ⇒ 结构化 + 图签名兜底（与油猴 findStopGeneratingBtnStructural 同构：
    //   form 优先，否则从 parentElement 向上 8 层找含圆钮的根）
    let root = null
    if (box) {
      root = box.closest('form')
      if (!root) {
        let p = box.parentElement
        for (let i = 0; i < 8 && p; i++) {
          if (p.querySelector(circleSel)) { root = p; break }
          p = p.parentElement
        }
      }
    }
    let dsBtn = null
    for (const el of (root || document).querySelectorAll(circleSel)) {
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue
      dsBtn = el // 只认第一个可用圆钮（与油猴 findStopGeneratingBtnStructural 一致）
      break
    }
    if (!dsBtn) return false
    const paths = dsBtn.querySelectorAll('svg path')
    for (let i = 0; i < paths.length; i++) {
      const d = paths[i].getAttribute('d') || ''
      if (dsAnchors.some(a => d.includes(a))) return true
    }
    // 圆钮在但图标两锚点均未命中 ⇒ fail-open 按非生成态（与油猴 hasDeepSeekStopIcon 同语义：
    //   站点改版后静默失效，不误判生成中）
    return false
  }

  // [stopped-btn-v1] 「本轮无新增 assistant 内容」判据（与油猴 rootsFrozenNow 的「计数与
  //   最后根身份均未变」同义：生成没产出任何回复块）。
  // [WHY] 独立成纯函数：detectReplyInPage 是 page.evaluate 序列化的巨型闭包、无 harness 先例，
  //   判据提出来后可由守卫测试直接行为覆盖（stopped-baseline-guard 的 parity 段）。
  // [CONSTRAINT] 基线为 '' 哨兵（空会话/未 fill）时恒 false：无基线可比时保守不推 stopped。
  function noNewAssistantContent(baselineHash, nowHash) {
    return typeof baselineHash === 'string'
      && baselineHash !== ''
      && (nowHash === '' || nowHash === baselineHash)
  }

  // [stopped-marker-v2] 平台自停的两类页面信号，一次扫出（与油猴 hasContinueBtn/hasStoppedLabel 同构）：
  //   ① byBtn：「继续生成」按钮存在（已产出部分内容后被中断）
  //   ② byLabel：当前轮回复区出现「已停止」角标（无继续按钮时的唯一信号，社区 dsh-continuechat 实证）
  function detectStoppedMarkersInPage() {
    const out = { byBtn: false, byLabel: false }
    const BTN_RE = /^(?:继续生成|继续回答|继续输出|Continue generating)$/i
    for (const el of document.querySelectorAll('button, div[role="button"], [role="button"]')) {
      const label = String(el.getAttribute('aria-label') || el.textContent || '').trim()
      if (label && BTN_RE.test(label)) { out.byBtn = true; break }
    }
    // [CONSTRAINT] 三重保险：精确等值 + 排除正文 + 要求同容器有 svg
    const list = document.querySelectorAll('.ds-assistant-message-main-content')
    const root = list.length ? list[list.length - 1] : null; if (root) {
      // [stopped-label-v2] 角标在思考块头部（正文容器的兄弟），须上溯到整条消息容器
      const msgScope = root.closest('.ds-message') || root
      for (const el of msgScope.querySelectorAll('span, div')) {
        if (el.closest('.ds-markdown, pre, code')) continue
        if (String(el.textContent || '').trim() !== '已停止') continue
        if (el.querySelector('svg') || el.parentElement?.querySelector('svg')) { out.byLabel = true; break }
      }
    }
    return out
  }

  // [stopped-btn-v1] ① 按钮从有到无 + 无新产出（思考期被停）② 继续按钮存在（[stopped-continue-btn-v1]）。
  // [CONSTRAINT] 位置须在基线 hash 守卫之前：挪后则思考期被停永远推不出 stopped（勿回退）。
  if (!dedup._stoppedReported) {
    const currGen = isGeneratingInPage()
    const wasGen = dedup._prevGenBtn === true
    dedup._prevGenBtn = currGen
    // [stopped-marker-v2] 三条判据任一成立即自停：①按钮从有到无+无新增 ②继续按钮 ③已停止角标
    const markers = detectStoppedMarkersInPage()
    if ((wasGen && !currGen && noNewAssistantContent(dedup._baselineLastHash, hashLastAssistant())) || markers.byBtn || markers.byLabel) {
      dedup._stoppedReported = true
      // [stopped-toast-quote-v1] 文案分段拼接：整句字面量会成为探针源码的自命中
      // （本文件会被工作台 dump 进会话，同 limit 探针的自指教训）
      return { kind: 'stopped', text: 'AI 网页' + '已停止' + '生成' }
    }
  }

  // [limit-detect-v3] 会话长度上限感知：触顶后继续提问不可能有产出，与「已停止」同构——
  // 无 DONE、无完整脚本、plain 被 hasJsFence 拦 → 前端无感知干等超时。
  // [WHY] DeepSeek 实际文案是「达到对话长度上限」+「请开启新对话」（动词在前）。
  // [CONSTRAINT] 引述真文案必须分两段引号：连写成一行会被本探针自己的正则命中 ⇒ 工作台 dump 该文件即自指误报。
  //   中文触顶必须自带动作子句（v2 允许裸标记命中，实测正文自指 + 侧栏「开启新对话」在 textContent 相接会假命中）。
  // [CONSTRAINT] 基线去重保留：只在计数增长时推送，排除历史旧标记；正则须与 headless-fill.ts、油猴三处同构。
  // [limit-en-branch-v1] 英文 `maximum context length` 原裸匹配 ⇒ 被 dump 的源码自指命中；
  //   改为必须邻近 token 数（`(?:is|of)\s*\d+` 或后随 `\d+\s*tokens`），真实 API 错文仍命中（此处不写真数字）。
  if (!dedup._limitReported) {
    const limitMessages = scanText.match(/(?:(?:达到|已达|超出|超过)\s*(?:对话|会话|上下文)(?:长度)?\s*(?:上限|最大长度|超限|过长)|(?:对话|会话|上下文)(?:长度)?\s*(?:已达|已达到|达到|超出|超过)\s*(?:上限|最大长度|超限|过长)|(?:对话|会话|上下文)(?:长度)?超限|(?:对话|会话|上下文)(?:长度)?\s*(?:上限|最大长度|过长))(?:[，,：:]\s*请?|请)(?:开启|开始|新建|创建)(?:一个)?新(?:对话|会话)|context length (?:limit|exceeded|too long)|maximum context length (?:is|of)\s*\d+|maximum context length\s+\d+\s*tokens/gi) || []
    const limitBaseline = typeof dedup._limitBaseline === 'number' ? dedup._limitBaseline : 0
    // [limit-detect-v2] 存量兜底：会话此前已触顶时提示常驻（fill 时即可见），计数不再增长；
    // 此时若本轮又无新增 assistant 块（重发同样拿不到产出），一并判定触顶，免去干等超时
    const limitGrew = limitMessages.length > limitBaseline
    const limitStale = limitMessages.length > 0 && typeof dedup._baselineBlocks === 'number' && _baseBlocks.length > 0 && _baseBlocks.length <= dedup._baselineBlocks
    if (limitGrew || limitStale) {
      dedup._limitReported = true
      return { kind: 'limit', text: limitMessages[limitMessages.length - 1] }
    }
  }

  // [virtual-list-baseline-v1] 主判据：最后一条 assistant 消息内容 hash 是否与本轮基线不同。
  // [WHY] DeepSeek 已切虚拟列表（.ds-virtual-list），生成新消息时会回收视口外旧消息 ⇒
  //   实时 assistant 块数会下降（实测 3→1→2）⇒ 原计数判据 `_baseBlocks.length <= _baselineBlocks`
  //   恒真 ⇒ 恒 return null ⇒ 无头静默丢回复（工作台报「AI 思考中」永不结束）。
  //   hash 判据不受回收影响：新回复到达时「最后一条」内容必然变化。
  // [CONSTRAINT] hash 算法必须与 resetReplyDedupInPage 中记录的 _baselineLastHash 逐字符一致（FNV-1a 32bit）。
  // [CONSTRAINT] 哨兵 '' = 无基线（首轮/无 assistant），不拦截；无 assistant 时保守判「无新回复」。
  function hashLastAssistant() {
    const els = document.querySelectorAll('.ds-assistant-message-main-content')
    if (els.length === 0) return ''
    const t = (els[els.length - 1].textContent || '')
    if (t.length === 0) return ''
    let h = 0x811C9DC5
    for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x1000193) >>> 0
    return (h >>> 0).toString(16).padStart(8, '0')
  }
  if (typeof dedup._baselineLastHash === 'string') {
    const _nowHash = hashLastAssistant()
    if (dedup._baselineLastHash !== '' && (_nowHash === '' || _nowHash === dedup._baselineLastHash)) return null
  } else if (typeof dedup._baselineBlocks === 'number' && _baseBlocks.length > 0 && _baseBlocks.length <= dedup._baselineBlocks) {
    // 旧 reset 写入路径（无 _baselineLastHash）：保留计数判据兜底
    return null
  }

  function langFromText(text) {
    const t = String(text || '').trim().toLowerCase()
    if (!t || t.length > 24) return null
    if (/^(?:bash|sh|shell|zsh)\b/.test(t)) return 'bash'
    if (/^(?:js|javascript|cjs|commonjs|node|nodejs)\b/.test(t)) return 'js'
    return null
  }

  // [script-fence-guess-removed-v1] guessLang* 三件套已删：只服务于已删除的 extractLatestScript。

  /** 检测文本是否含 js 代码块（接收端容错） */
  function hasJsFence(text: string): boolean {
    // [hasjsfence-dom-v1] DOM 优先检测 <pre><code>：getMainText() 返回 DOM textContent（不含 markdown 反引号），
    //   原字面量正则 ```js 在 textContent 上永远 false → plain 兜底分支 line 380 从不成立 → 前端静默收不到回复
    // [CONSTRAINT] 只看最后一条 assistant 消息；本文件经 page.evaluate 序列化执行，禁止引用外部闭包变量
    // [CHANGE-IMPACT] 影响 line 380 的 plain 推送决策：修复后含任意代码块的回复会推 plain（原意为过滤纯问候语）
    // [ds-pre-no-code-v1] DeepSeek 现版代码块是 <pre> 内**无** <code>（实测 DOM pres:1 / codes:0），
    //   只匹配 'pre code' 会让「含代码块但语言非 js/bash」的回复漏过 plain 推送门槛（前端静默收不到）。
    // [CONSTRAINT] script 链路不受此影响：那条走 extractLatestScript，已用 pre code || pre 回退
    const blocks = document.querySelectorAll('.ds-assistant-message-main-content')
    // [no-root-no-reply-v1] 容器不存在（新会话首轮「已思考/搜索」期）不得退回整页：
    //   用户首条消息（如 SYSTEM.md 卡）里的代码块会被当 js 围栏误开 plain 门槛
    const root = blocks.length > 0 ? blocks[blocks.length - 1] : null
    if (root && root.querySelectorAll('pre code, pre').length > 0) return true
    return /```js\b/.test(String(text || ''))
  }

  // [reply-mark-v1] 统一回复标记识别：`SCRIPT` / `ASK` / `DONE` / `HANDOFF` / `TEXT` 共用「首行标记行」判据
  // [WHY] 原先四类分流各写各的：SCRIPT 完全没有标记行，靠 DOM 结构 + 语言标签三级回退猜；
  //   本处 ASK 只看首个非空行前缀，前端 utils/ask-parser.ts 的 m flag 却认任意行 →
  //   「先说理再提问」在此处被判非标记，又无代码块 → plain 门槛直接 return null，整轮被丢弃。
  //   且 script 判定排在 done 之前 → `DONE` 总结里带一个 js 代码块就会被当脚本重新执行。
  //   现统一为「首个非空行 = 独占一行的标记行，第二行起才是载荷」，标记行优先于 DOM 结构判定。
  // [marker-naming-v1] 标记取纯大写英文单词（无 `@` / `#` 前缀）：`@` 会被当 mention、
  //   `#` 与 Markdown 标题同形（elToMd 把 <h1> 还原成 `# xxx`），纯大写单词无此耦合。
  //   [alias-removed-v1] 2026-10-07：过渡别名已全部移除，五类标记只有纯大写单词一种形态
  // [CONSTRAINT] 只认首个非空行：正文里引用 `DONE`、贴含 `ASK` 的示例都不会误触发（无需围栏排除）
  // [CONSTRAINT] 本函数经 page.evaluate 序列化执行，禁止引用外部闭包变量；
  //   内部不得出现 TS 类型注解（守卫测试 reply-mark-parity 要抠出花括号内部直接执行）；
  //   与 packages/client/utils/reply-mark.ts 的同名实现逐句同构，改一处必须同步另一处。
  function scanReplyMarks(md: string) {
    const out = { script: -1, ask: -1, done: -1, handoff: -1, text: -1 }
    const lines = String(md || '').split(/\r?\n/)
    let head = -1
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().length > 0) { head = i; break }
    }
    if (head < 0) return out
    const line = lines[head].trim()
    if (/^SCRIPT$/.test(line)) out.script = head + 1
    else if (/^ASK$/.test(line)) out.ask = head + 1
    else if (/^DONE$/.test(line)) out.done = head + 1
    else if (/^HANDOFF$/.test(line)) out.handoff = head + 1
    else if (/^TEXT$/.test(line)) out.text = head + 1
    return out
  }

  // [script-fence-guess-removed-v1] decideScriptFence 已删：无围栏不再视为异常。

  // [script-fence-guess-removed-v1] extractLatestScript 已删：脚本意图由 turn 信封决定，不再按围栏语言猜。

  // 取当前页面主文本（AI 回复区）
  function getMainText() {
    // 只取最后一条 assistant 消息的文本
    const blocks = document.querySelectorAll('.ds-assistant-message-main-content')
    if (blocks.length === 0) return ''
    const el = blocks[blocks.length - 1]
    const t = (el && el.textContent) || ''
    return t.slice(-8000)
  }

  /**
   * DOM → Markdown 反推：允许 AI 输出纯 Markdown 总结，但 DOM 抓取会丢换行
   * [WHY] textContent 会把 <h3>/<p>/<ul> 全部粘成一整行；需按标签结构重建 Markdown 源码
   * [CONSTRAINT] 只覆盖 DeepSeek 渲染使用的常见标签；未知标签递归取子节点文本（兜底）
   * [CHANGE-IMPACT] 输出直接喂给前端 renderMarkdown，标签→语法映射必须与其对齐
   */
  function elToMd(node: Node | null): string {
    if (!node) return ''
    if (node.nodeType === 3) return node.textContent || ''
    if (node.nodeType !== 1) return ''
    const el = node as Element
    const tag = el.tagName.toLowerCase()
    const inner = (): string => Array.from(el.childNodes).map(c => elToMd(c)).join('')
    if (tag === 'br') return '\n'
    if (tag === 'hr') return '\n---\n\n'
    if (/^h[1-6]$/.test(tag)) return `${'#'.repeat(Number(tag.charAt(1)))} ${inner().trim()}\n\n`
    if (tag === 'p') return `${inner().trim()}\n\n`
    if (tag === 'ul' || tag === 'ol') {
      const out: string[] = []
      let i = 1
      for (const c of Array.from(el.children)) {
        if (c.tagName.toLowerCase() !== 'li') continue
        out.push((tag === 'ul' ? '- ' : `${i++}. `) + elToMd(c).trim())
      }
      return `${out.join('\n')}\n\n`
    }
    if (tag === 'pre') {
      const code = el.querySelector('code')
      const cls = code ? String(code.className || '') : ''
      const m = cls.match(/language-([a-z0-9]+)/i)
      const src = (code || el).textContent || ''
      return `\`\`\`${m ? m[1] : ''}\n${src.replace(/\n+$/g, '')}\n\`\`\`\n\n`
    }
    if (tag === 'code') return `\`${el.textContent || ''}\``
    if (tag === 'blockquote') return `${inner().split('\n').map((l: string) => `> ${l}`).join('\n')}\n\n`
    if (tag === 'table') {
      const rows: string[] = []
      for (const tr of Array.from(el.querySelectorAll('tr'))) {
        rows.push(`| ${Array.from(tr.children).map(c => elToMd(c).trim()).join(' | ')} |`)
      }
      return `${rows.join('\n')}\n\n`
    }
    return inner()
  }

  /** 从容器节点提取 Markdown；传入 document 时自动取 body */
  function extractReplyMd(root: Node | null): string {
    if (!root) return ''
    const node: Node | null = root.nodeType === 9 ? (root as Document).body : root
    if (!node) return ''
    return elToMd(node).replace(/\n{3,}/g, '\n\n').trim()
  }

  /**
   * 查找新已完成
   * [done-plain-v1] 协议：首行 `DONE`（独占一行）+ 第二行起为 Markdown 总结（无需 js 围栏）
   * [reply-mark-v1] 判据走统一标记扫描：只认首个非空行的独占标记行，
   *   正文里写「DONE 之后就不再输出」不会命中
   * [CONSTRAINT] 只取最后一条 assistant 消息
   * [CHANGE-IMPACT] marker 用首 200 字符 + 全长拼接；text 为 DOM→Markdown 反推结果（含换行）
   */
  function findNewDone() {
    const blocks = document.querySelectorAll('.ds-assistant-message-main-content')
    // [no-root-no-reply-v1] 容器缺失 ⇒ 无 DONE 可言；整页反推会把用户首条消息扫进来
    if (blocks.length === 0) return null
    const root = blocks[blocks.length - 1]
    const full = extractReplyMd(root)
    if (!full) return null
    if (scanReplyMarks(full).done < 0) return null
    // [done-marker-no-len-v1] marker 不得掺 full.length：AI 流式追加时每帧长度都变 →
    //   每次都是「新 marker」→ 同一 DONE 被推成 N 张卡（用户实测三份）。头部 200 字已足以去重。
    const marker = hash32(`done-head|${full.slice(0, 200)}`)
    if (dedup.seenDoneMarkers.includes(marker)) return null
    return { marker, text: full }
  }

  function bodySignature() {
    const cache = dedup._sigCache
    if (cache.version === dedup._bodyVersion && cache.sig) return cache.sig
    const t = (document.body.textContent || '').replace(/\s+/g, ' ')
    const s = hash32(t.slice(-300))
    cache.version = dedup._bodyVersion
    cache.sig = s
    return s
  }

  // [turn-schema-v1] JSON 信封解析器（**生成段，禁止手改**）。
  // [WHY] 本函数整段被 page.evaluate 序列化送进浏览器，模块级 import / 引用在浏览器侧必然 ReferenceError
  //   ⇒ 解析器只能内联在函数体内。前端副本与油猴片段各有同一份，三处靠内容指纹守卫（reply-turn-fingerprint）
  //   锁死：「嵌入哈希 == 重算源哈希」且「代码体逐字相同」，改源不重建即红。
  // [CONSTRAINT] 生成源是 packages/core/src/reply/turn-schema.ts；重建命令 pnpm turn-schema:sync。
  // [CHANGE-IMPACT] 接线在 P2：扫**全部** pre > code、信封优先、标记回落、且不得继承 stoppedThisRound 抑制。
  /* eslint-disable unused-imports/no-unused-vars, ts/no-unused-vars -- 生成段：符号是否被调用取决于接线进度 */
  /* @turn-schema:5f70fe35f55c21c0 */
  // >>> BEGIN turn-schema
  // [turn-schema-v1] turn 信封契约的**唯一源**。
  //
  // 为什么是唯一源：本文件会被 scripts/sync-turn-schema.mjs 复制成三份产物
  // （无头内联段 / 油猴片段 / 前端副本），三份头部各带 `/* @turn-schema:<hash> */`，
  // 由 reply-turn-fingerprint 守卫重算源哈希比对 —— 「三处同一份源码」是判据，不是承诺。
  //
  // [CONSTRAINT] 本文件必须保持「纯 JS 可执行」：
  //   · 不写 TS 注解（生成器直接复制，不做类型擦除）
  //   · 不 import 任何模块（无头侧 page.evaluate 不能加载模块）
  //   · 不用 Date / Math.random（解析必须幂等，同输入同输出）
  //   · 不读全局状态（不得依赖 window / document / process）
  //
  // 契约形状（v1）：
  //   { "v": 1, "turn": 7, "content": [ {type:'say'|'script'|'ask'|'handoff', ...} ] }
  // 派生语义（不由本文件决定，由调用方按块列表推导）：
  //   有 ask 块 ⇒ 停循环等用户；有 script 块 ⇒ 执行后回灌；无执行块 ⇒ 本 turn 即总结；
  //   有 handoff 块 ⇒ 轮转会话。
  // [CONSTRAINT] 首版**不含 lane**：schema 只声明已实现的能力，不支持的东西必须报错而非静默丢弃。

  /** 契约版本（写进 `v` 字段；缺省按 1 处理） */
  const TURN_SCHEMA_VERSION = 1

  /** 已实现的块类型（注册表）。新增工具类型 = 往这里加一项 + 在 validateBlock 加一个分支 */
  const TURN_BLOCK_TYPES = ['say', 'script', 'ask', 'handoff']

  /** script 块可接受的 lang（白名单，不做别名归一：别名会让「写错」变成「猜对了」） */
  const TURN_SCRIPT_LANGS = ['js', 'cjs']

  /**
   * 找出所有候选 JSON 起点（每个 ```json 围栏内的第一个 `{`，以及整段以 `{` 开头的情形）。
   * [WHY] 不能用 ```…``` 正则截体：script.code 里一旦出现反引号围栏（脚本要输出 Markdown 时很常见），
   *   正则会提前闭合，把整条回复打成噪音卡。这里只定位起点，终点交给配平扫描。
   * @param text 原文
   * @returns 起点下标数组（升序）
   */
  function findCandidates(text) {
    const out = []
    const re = /```[ \t]*json[ \t]*\r?\n[ \t]*\{/gi
    let m = re.exec(text)
    while (m) {
      out.push(m.index + m[0].length - 1)
      m = re.exec(text)
    }
    const trimmed = text.trim()
    if (trimmed.charAt(0) === '{') {
      const at = text.indexOf('{')
      if (!out.includes(at)) out.push(at)
    }
    return out
  }

  /**
   * 从 from 处的 `{` 起做**字符串感知**的花括号配平，返回对象结束后的下标（开区间）。
   * [CONSTRAINT] 必须跳过字符串内部的括号与 `\"` 转义，否则 `{"code":"} "}` 会提前闭合。
   * @param text 原文
   * @param from 起点（必为 `{`）
   * @returns 结束下标；未闭合返回 -1
   */
  function scanObjectEnd(text, from) {
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = from; i < text.length; i++) {
      const ch = text.charAt(i)
      if (inStr) {
        if (esc) { esc = false; continue }
        if (ch === '\\') { esc = true; continue }
        if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') { inStr = true; continue }
      if (ch === '{') { depth += 1; continue }
      if (ch === '}') {
        depth -= 1
        if (depth === 0) return i + 1
      }
    }
    return -1
  }

  /**
   * 在 content 数组内部逐个切出**已配平**的元素对象（流式安全的增量解析基础）。
   * [WHY] 整段信封闭合要等模型写完最后一笔；而脚本块一配平就该能开跑（等价 API 的
   *   content_block_start）。本函数只切元素，不做校验，校验交给 validateBlock。
   * @param text 原文
   * @returns 元素原文数组（可能不完整，末尾元素可能缺失）
   */
  function sliceContentElements(text) {
    const out = []
    const at = text.search(/"content"\s*:\s*\[/)
    if (at < 0) return out
    let i = text.indexOf('[', at)
    if (i < 0) return out
    i += 1
    let depth = 0
    let inStr = false
    let esc = false
    let start = -1
    for (; i < text.length; i++) {
      const ch = text.charAt(i)
      if (inStr) {
        if (esc) { esc = false; continue }
        if (ch === '\\') { esc = true; continue }
        if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') { inStr = true; continue }
      if (ch === '{') {
        if (depth === 0) start = i
        depth += 1
        continue
      }
      if (ch === '}') {
        depth -= 1
        if (depth === 0 && start >= 0) {
          out.push(text.slice(start, i + 1))
          start = -1
        }
        continue
      }
      if (ch === ']' && depth === 0) break
    }
    return out
  }

  /**
   * 校验并归一化单个块。
   * [CONSTRAINT] 返回 `{ block, errors }`：block 为 null 表示该块不可用（errors 非空）。
   *   字段一律「有就收窄、没有就补默认值或报错」，绝不抛异常。
   * @param raw 原始元素
   * @param index 在 content 中的下标（用于错误定位）
   */
  function validateBlock(raw, index) {
    const errors = []
    const at = `#${index + 1}`
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push({ code: 'BLOCK_UNKNOWN_TYPE', block: at, field: 'type', detail: '块不是对象' })
      return { block: null, errors }
    }
    const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : ''
    if (!TURN_BLOCK_TYPES.includes(type)) {
      errors.push({ code: 'BLOCK_UNKNOWN_TYPE', block: at, field: 'type', detail: type || '（缺失）' })
      return { block: null, errors }
    }
    const rawId = typeof raw.id === 'string' ? raw.id.trim() : ''

    if (type === 'say') {
      const text = typeof raw.text === 'string' ? raw.text : ''
      if (!text.trim()) errors.push({ code: 'BLOCK_MISSING_FIELD', block: rawId || at, field: 'text' })
      return { block: { type: 'say', id: rawId || (`say_${index + 1}`), text }, errors }
    }

    if (type === 'handoff') {
      const summary = typeof raw.summary === 'string' ? raw.summary : (typeof raw.text === 'string' ? raw.text : '')
      if (!summary.trim()) errors.push({ code: 'BLOCK_MISSING_FIELD', block: rawId || at, field: 'summary' })
      return { block: { type: 'handoff', id: rawId || (`handoff_${index + 1}`), summary }, errors }
    }

    if (type === 'ask') {
      const question = typeof raw.question === 'string' ? raw.question : ''
      if (!rawId) errors.push({ code: 'BLOCK_MISSING_FIELD', block: at, field: 'id' })
      if (!question.trim()) errors.push({ code: 'BLOCK_MISSING_FIELD', block: rawId || at, field: 'question' })
      const rawOptions = Array.isArray(raw.options) ? raw.options : []
      const options = []
      for (let i = 0; i < rawOptions.length; i++) {
        const o = rawOptions[i]
        const label = o && typeof o === 'object' && typeof o.label === 'string' ? o.label : ''
        if (!label.trim()) continue
        const oid = o && typeof o.id === 'string' && o.id ? o.id : (`opt_${options.length + 1}`)
        options.push({ id: oid, label })
      }
      return { block: { type: 'ask', id: rawId || (`ask_${index + 1}`), question, options }, errors }
    }

    // type === 'script'
    const lang = typeof raw.lang === 'string' ? raw.lang.trim().toLowerCase() : ''
    const desc = typeof raw.desc === 'string' ? raw.desc : ''
    const why = typeof raw.why === 'string' ? raw.why : ''
    const code = typeof raw.code === 'string' ? raw.code : ''
    if (!rawId) errors.push({ code: 'BLOCK_MISSING_FIELD', block: at, field: 'id' })
    if (!lang) errors.push({ code: 'BLOCK_MISSING_FIELD', block: rawId || at, field: 'lang' })
    else if (!TURN_SCRIPT_LANGS.includes(lang)) errors.push({ code: 'BLOCK_BAD_LANG', block: rawId || at, field: 'lang', detail: lang })
    if (!desc.trim()) errors.push({ code: 'BLOCK_MISSING_FIELD', block: rawId || at, field: 'desc' })
    if (!why.trim()) errors.push({ code: 'BLOCK_MISSING_FIELD', block: rawId || at, field: 'why' })
    if (!code.trim()) errors.push({ code: 'BLOCK_MISSING_FIELD', block: rawId || at, field: 'code' })
    return {
      block: { type: 'script', id: rawId, lang, desc, why, code },
      errors,
    }
  }

  /**
   * 把已校验的块并入结果集，处理同 id 复用。
   * [D8] 未执行的块可以覆盖、已执行的块只能上报 —— 解析层无法知道执行状态，因此这里统一
   *   「后到覆盖先到」并把冲突记进 errors；是否重跑由执行器的 (turn,id) 账本决定。
   * @param acc 累积结果 { blocks, errors }
   * @param block 校验通过的块
   */
  function mergeBlock(acc, block) {
    if (!block || !block.id) { acc.blocks.push(block); return }
    const idx = acc.blocks.findIndex((it) => { return it && it.id === block.id })
    if (idx < 0) { acc.blocks.push(block); return }
    const prev = acc.blocks[idx]
    if (JSON.stringify(prev) === JSON.stringify(block)) return
    acc.blocks[idx] = block
    acc.errors.push({ code: 'BLOCK_DUP_ID', block: block.id, field: 'id', detail: 'superseded' })
  }

  /**
   * 把 JSON **字符串字面量内部**的裸控制字符改写成合法转义，再交给 JSON.parse。
   *
   * [WHY] 模型写 script.code 时经常图省事，直接在 `"code": "..."` 里敲**真换行**（U+000A）
   *   而不是两字符的 `\n`。这不是排版问题而是转义问题：`JSON.parse` 对字符串字面量里的
   *   裸控制字符直接抛 `Bad control character in string literal`，整条信封解析不出对象
   *   ⇒ 油猴回落 plain 把 JSON 原文整坨推上屏、script 块零执行（用户实测 2026-10-19，
   *   对照组：同结构的单行/合法转义信封一切正常）。
   *   所以「能跑的」和「不能跑的」两份信封差异**不在块结构，只在 code 里换行的形态**。
   *
   * [CONSTRAINT] 必须字符串感知：只改字符串内部的控制字符，且跳过 `\"` 已消费的位置。
   *   否则代码里的引号会被误判成字符串边界，把结构字符（`{` `}` `,`）也转义掉，
   *   修好一个坏两个。
   * [CONSTRAINT] 只在 JSON.parse 已经失败时兜底调用（见 safeJsonParse），正常信封零开销、
   *   且严格 JSON 的行为完全不变（严格解析成功时压根不进这里）。
   * [CONSTRAINT] 幂等：已转义文本再过一次不产生变化（`\` 已消费 ⇒ 下一个字符不处理）。
   * @param text 待解析的 JSON 文本
   * @returns 修正后的 JSON 文本
   */
  function escapeControlCharsInStrings(text) {
    let out = ''
    let inStr = false
    let esc = false
    for (let i = 0; i < text.length; i++) {
      const ch = text.charAt(i)
      if (inStr) {
        if (esc) { out += ch; esc = false; continue }
        if (ch === '\\') { out += ch; esc = true; continue }
        if (ch === '"') { inStr = false; out += ch; continue }
        const code = text.charCodeAt(i)
        // JSON 规范：字符串字面量内只允许码位 ≥ 0x20，其余必须转义
        if (code < 0x20) {
          if (ch === '\n') out += '\\n'
          else if (ch === '\r') out += '\\r'
          else if (ch === '\t') out += '\\t'
          else if (ch === '\b') out += '\\b'
          else if (ch === '\f') out += '\\f'
          else out += `\\u${code.toString(16).padStart(4, '0')}`
          continue
        }
        out += ch
        continue
      }
      if (ch === '"') inStr = true
      out += ch
    }
    return out
  }

  /**
   * JSON.parse 的宽容包装：严格解析失败时，转义字符串内的裸控制字符再试一次。
   *
   * [WHY] 不直接无条件转义：严格 JSON 是契约基线，先严格试能保证「本来就能解析的输入
   *   走的是零改写的原路径」，宽容只作为**救 malformed 输出**的兜底，不放宽块结构校验
   *   （字段缺失 / 未知类型仍然照常报错，不会因为宽容而静默通过）。
   * @param text JSON 文本
   * @returns 解析结果；两次都失败抛错（由调用方按既有 try/catch 处理）
   */
  function safeJsonParse(text) {
    try {
      return JSON.parse(text)
    } catch {
      return JSON.parse(escapeControlCharsInStrings(text))
    }
  }

  /**
   * 解析一条完整的 turn 信封。
   * @param md 回复原文（Markdown 或裸 JSON 均可）
   * @returns {turn, blocks, truncated, errors}；解析不出对象时 errors 含
   *   TURN_TRUNCATED（未配平＝还在流式写入）或 TURN_NOT_JSON（配平了但不是对象）
   */
  function parseTurn(md) {
    const text = String(md ?? '')
    const out = { turn: null, blocks: [], truncated: false, errors: [] }
    if (!text) {
      out.errors.push({ code: 'TURN_NOT_JSON', detail: '空输入' })
      return out
    }
    const cands = findCandidates(text)
    if (!cands.length) {
      out.errors.push({ code: 'TURN_NOT_JSON', detail: '无 json 围栏且不以 { 开头' })
      return out
    }
    let obj = null
    for (let i = cands.length - 1; i >= 0; i--) {
      const end = scanObjectEnd(text, cands[i])
      if (end < 0) { out.truncated = true; continue }
      let parsed = null
      try { parsed = safeJsonParse(text.slice(cands[i], end)) } catch { continue }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      obj = parsed
      break
    }
    if (!obj) {
      // [CONSTRAINT] 两种「没解析出对象」必须区分开，否则模型拿到的修法是错的：
      //   · 围栏已开但对象还没配平 ⇒ 还在流式写入（TURN_TRUNCATED），等下一拍即可；
      //   · 围栏配平了但里面不是对象 ⇒ 真的写错了（TURN_NOT_JSON），必须改写。
      out.errors.push(out.truncated
        ? { code: 'TURN_TRUNCATED', detail: '围栏已开但对象未配平（流式未写完）' }
        : { code: 'TURN_NOT_JSON', detail: '围栏内不是可解析的对象' })
      return out
    }
    if (typeof obj.turn === 'number') out.turn = obj.turn
    const content = Array.isArray(obj.content) ? obj.content : null
    if (!content || content.length === 0) {
      out.errors.push({ code: 'TURN_NO_CONTENT', detail: '缺 content 或为空数组' })
      return out
    }
    for (let i = 0; i < content.length; i++) {
      const r = validateBlock(content[i], i)
      for (let k = 0; k < r.errors.length; k++) out.errors.push(r.errors[k])
      if (r.block) mergeBlock(out, r.block)
    }
    return out
  }

  /**
   * 增量解析：只返回**已配平**的 content 元素，不等整信封闭合。
   * [WHY] 流式下脚本块写完就该能开跑；等整段闭合会把多块 turn 的延迟叠加成 N 倍。
   * [CONSTRAINT] 不返回 truncated 判断 —— 是否「真的截断」由调用方的静默窗决定，
   *   解析层只负责「现在能确定什么」。
   * @param md 回复原文
   * @returns {turn, blocks, errors}：只含**已配平**元素的解析结果，未闭合部分不出块
   */
  function parseTurnPartial(md) {
    const text = String(md ?? '')
    const out = { turn: null, blocks: [], errors: [] }
    const turnMatch = text.match(/"turn"\s*:\s*(\d+)/)
    if (turnMatch) out.turn = Number(turnMatch[1])
    const elems = sliceContentElements(text)
    for (let i = 0; i < elems.length; i++) {
      let parsed = null
      try { parsed = safeJsonParse(elems[i]) } catch { continue }
      const r = validateBlock(parsed, i)
      for (let k = 0; k < r.errors.length; k++) out.errors.push(r.errors[k])
      if (r.block) mergeBlock(out, r.block)
    }
    return out
  }
  // <<< END turn-schema
  /* eslint-enable unused-imports/no-unused-vars, ts/no-unused-vars */

  /**
   * [turn-envelope-v1] 本轮结束后循环等什么。优先级 **script > ask > none**。
   * [WHY 不让前端各自推导] 三处推导必然在「既有 script 又有 ask」上分叉，
   *   而分叉的后果是循环要么空转要么提前结束，没有任何一处会报错。
   * [parity] 与 core/reply/turn-frames.ts 的 deriveAwaiting、油猴 turn-emit.ts 的 turnAwaiting 同构。
   */
  function turnAwaiting(blocks) {
    let hasScript = false
    let hasAsk = false
    for (let i = 0; i < blocks.length; i++) {
      const t = blocks[i] && blocks[i].type
      if (t === 'script') hasScript = true
      else if (t === 'ask') hasAsk = true
    }
    if (hasScript) return 'results'
    if (hasAsk) return 'user'
    return 'none'
  }

  /** [turn-envelope-v1] 是否含 handoff 块（轮转会话）。与 awaiting 正交 */
  function turnRotate(blocks) {
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i] && blocks[i].type === 'handoff') return true
    }
    return false
  }

  // [turn-envelope-v1] 从页面读信封：扫**全部** `pre > code` 的 textContent，逐个试 parseTurn。
  //
  // [WHY] 不复用语言闸门：P0 实测（2026-10-19）该渲染器把语言标签渲染成 `<pre>` 内的**文本节点**
  //   （`js` / `复制` / `下载`），`guessLangFromClass` 与 `guessLangFromDom` 都取不到 ⇒
  //   按语言筛会把信封整个漏掉。唯一可靠的判据是「这段文本能否被 parseTurn 解析成信封」。
  // [WHY] 取 `textContent` 而非 `elToMd` 反推：P0 两档载荷（5264 B / 11214 B）逐字节相等，
  //   0 个不可见字符；反推路径会引入换行/转义改写，正是本方案要消灭的失真源。
  // [CONSTRAINT] 只在信封**闭合**时返回；`truncated` ⇒ 返回 null 等下一拍。
  //   流式增量由 parseTurnPartial 承担（P2-b 用 `pendingBlocks` 静默窗接入），此处不做半截交付。
  // [CONSTRAINT] 函数体内不得写 TS 注解（守卫用 vm 抠函数体真跑，注解会编译失败）；
  //   签名同理 —— 参数不加类型，靠文件级 @ts-nocheck。
  // [CHANGE-IMPACT] P2-b 起由下方「信封优先」分支调用；信封缺失时返回 null ⇒ 旧标记链路原样接管。
  /**
   * 收集围栏外的**散文**文本（只认 `<p>/<li>/<h1>-<h6>/<blockquote>/<td>/<th>` 内的文本节点，
   * 跳过 `<pre>` / `<script>` / `<style>`，并整棵剪掉 `button/a/svg` 与 `aria-hidden="true"` 子树）。
   * [WHY 只认散文元素] 初版遍历容器下全部非 pre 文本节点，把站点代码块**自带 UI** 也当成了
   *   围栏外文本——语言标签、复制/下载按钮文字都在容器里且不在 pre 内 ⇒ AI 明明一个字
   *   没写也被「回收」成假 say 块（用户实测 2026-10-20）。
   *   markdown 正文只会渲染成 p/li/标题/引用/表格单元格 ⇒ 以元素类别划界即可精确区分
   *   「AI 写的话」与「页面的界面文字」，不依赖任何站点特化选择器。
   * [parity] 与油猴 turn-emit.ts 的 outsideFenceText 逐字符同构（pure-parity 守卫对拍）。
   */
  function outsideFenceText(root) {
    if (!root || typeof root.childNodes === 'undefined') return ''
    let out = ''
    const PROSE = { P: true, LI: true, H1: true, H2: true, H3: true, H4: true, H5: true, H6: true, BLOCKQUOTE: true, TD: true, TH: true }
    const walk = (node, inProse) => {
      if (node.nodeType === 3) { if (inProse) out += node.nodeValue || ''; return }
      if (node.nodeType === 1) {
        const tag = (node.tagName || '').toUpperCase()
        if (tag === 'PRE' || tag === 'SCRIPT' || tag === 'STYLE') return
        // 按钮/链接/SVG 是界面操作件，其文字永远不是 AI 的围栏外正文
        if (tag === 'BUTTON' || tag === 'A' || tag === 'SVG') return
        // aria-hidden 文字是给读屏的装饰（图标替代文本等），不进采集
        if (typeof node.getAttribute === 'function' && node.getAttribute('aria-hidden') === 'true') return
        const kids = node.childNodes
        const next = inProse || PROSE[tag] === true
        for (let i = 0; i < kids.length; i++) walk(kids[i], next)
      }
    }
    walk(root, false)
    return out.replace(/\s+/g, ' ').trim()
  }

  function readTurnBlocks(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return null
    const pres = root.querySelectorAll('pre')
    if (pres && pres.length) {
      // 从后往前：信封通常是本回复最后一个代码块；命中即返回，不必扫完
      for (let i = pres.length - 1; i >= 0; i--) {
        const pre = pres[i]
        const codeEl = pre && typeof pre.querySelector === 'function' ? pre.querySelector('code') : null
        const codeText = codeEl && typeof codeEl.textContent === 'string' ? codeEl.textContent : ''
        const preText = pre && typeof pre.textContent === 'string' ? pre.textContent : ''
        const raw = codeText || preText
        if (!raw) continue
        let r = null
        try { r = parseTurn(raw) }
        catch { continue }
        if (!r || !r.blocks || r.blocks.length === 0) continue
        if (r.truncated) return null
        // [text-outside-fence-v1] 信封合法但围栏外有文本 ⇒ 回收成 say 块，避免被静默丢弃。
        //   [parity] 与油猴 turn-emit.ts readTurnFromRoot 同构（outsideFenceText 由 pure-parity 对拍）。
        //   [CONSTRAINT] 只走 `<pre>` 分支：裸 JSON 回退分支的 leading 文本会被 parseTurn 判 TURN_NOT_JSON，
        //     交给 turn-invalid 通道由工作台纠正，不在此回收。
        const outside = outsideFenceText(root)
        const blocks = r.blocks.slice()
        if (outside) {
          blocks.push({ type: 'say', id: `outside_${typeof r.turn === 'number' ? r.turn : 0}`, text: outside })
          r.errors = (r.errors || []).concat([{ code: 'TEXT_OUTSIDE_FENCE', detail: `围栏外文本 ${outside.length} 字已回收为 say 块` }])
        }
        return { turnId: typeof r.turn === 'number' ? r.turn : 0, blocks, errors: r.errors || [] }
      }
    }
    // [no-fence-envelope-v1] 与油猴 readTurnFromRoot 同构：无 <pre> 信封（回复未加 ```json 围栏）时
    //   回退解析整条回复文本。无围栏的裸 JSON 不进 <pre>，只扫 <pre> 会整轮找不到信封 ⇒
    //   回落 plain 把 JSON 正文推上屏、脚本零执行（用户实测 2026-10-19，油猴通道同源）。
    //   parseTurn 已支持以左花括号开头的裸 JSON，且要求非空 content ⇒ 普通文本 / 非信封 JSON 仍返回 null。
    // [CONSTRAINT] 函数体内注释不得出现字面花括号：守卫用朴素花括号配对抠函数体，会被注释里的括号带偏。
    const rawText = root && typeof root.textContent === 'string' ? root.textContent : ''
    if (rawText) {
      let rt = null
      try { rt = parseTurn(rawText) }
      catch { rt = null }
      if (rt && rt.blocks && rt.blocks.length > 0 && !rt.truncated) {
        return { turnId: typeof rt.turn === 'number' ? rt.turn : 0, blocks: rt.blocks, errors: rt.errors || [] }
      }
    }
    return null
  }

  // [reply-mark-v1] 标记行优先：先算首行标记，再决定是否走 DOM 结构判定。
  // [WHY] 带 ASK / DONE / HANDOFF 标记的回复若含代码块，旧逻辑会被 script 分支抢走（script 判定排在 done/plain 之前）
  //   → DONE 总结里的示例代码块会被当脚本重新执行。[CONSTRAINT] extractReplyMd 是 DOM→Markdown 反推（保留换行），
  //   getMainText 的 textContent 无换行、无法用于「首行」判定，故标记扫描一律基于前者。
  // [turn-envelope-v1] 但**信封比标记更优先**：见下方信封分支。
  const replyBlocks = document.querySelectorAll('.ds-assistant-message-main-content')
  // [no-root-no-reply-v1] 容器不存在（新会话首轮「已思考/搜索」期）⇒ replyRoot 置 null：extractReplyMd(null) 返回空串、
  //   marks 全 -1、getMainText() 返回空。原「兜底成 document」会把侧栏历史会话标题（未知标签递归 inner() 拼成连体乱文）
  //   + 用户首条消息卡反推成「回复」推给前端（2026-10-08 18:53 两张噪音卡根因，油猴通道同日同修）。
  const replyRoot: Element | null = replyBlocks.length > 0 ? replyBlocks[replyBlocks.length - 1] : null

  // [stopped-no-autorun-v1] 本轮已推过 stopped ⇒ 不再推送残余脚本块（与 plain 抑制同一生命周期）。
  // [WHY] 前端收 stopped 会 finish 整个循环；此后该回复里的闭合代码块若仍被推出，循环已非活动 ⇒
  //   前端 `autoTakeover.scheduleAutoRun`（无条件立即执行）会把它跑掉，形成无记账、无自检、无预算反馈的
  //   「循环外自动执行」旁路（WO-20261005 段三判定为缺陷）。_stoppedReported 随 fill 轮次重置，新一轮脚本不受影响。
  // [parity] scripts/tampermonkey-session-id.user.js classifyAndPost 有同构守卫（stopPosted 标志）
  const stoppedThisRound = Boolean(dedup._stoppedReported)

  // [turn-envelope-v1] 信封优先（契约 §2.1）：命中即整轮按块交付，**不再**走 marks / script / plain。
  // [WHY 必须最先] 信封正文是 JSON，旧标记扫描对它的判定无意义；且 script 分支排在 done/plain 之前，
  //   一旦被它抢走，信封里的多个块只剩最后一个会被推出（旧实现的历史缺陷源）。
  // [WHY 要带 kind:'turn'] `ai-headless` 的转发门是 `reply.kind` 真值判定；不带 kind 会被当成
  //   「poll 未命中」并记一条 poll-miss 诊断，前端则一条回复都收不到 —— 比不发更糟。
  // [CONSTRAINT] stopped 之后不读信封：与油猴 stopPosted 同构，避免「循环外自动执行」旁路。
  // [CONSTRAINT] 半截信封（truncated）由 readTurnBlocks 返回 null ⇒ 返回 null 等下一拍（围栏闭合后再交付）。
  // [turn-envelope-v1] 信封路径的去重账本：seenTurnIds 记录已交付的 turnId。
  // [WHY 必须去重] poll 每 800ms 重扫同一份 DOM，信封一旦闭合就会**每拍都命中**；
  //   不去重 ⇒ 前端每 800ms 收到一组同样的块帧 ⇒ 时间线持续多出重复卡片。
  // [WHY 防御式初始化] HMR / 旧页面 bundle 可能留下没有本字段的 dedup 对象，
  //   直接 `.push` 会 TypeError ⇒ 整条采集链路静默失效。
  if (!Array.isArray(dedup.seenTurnIds)) dedup.seenTurnIds = []
  if (!stoppedThisRound && replyRoot) {
    const turn = readTurnBlocks(replyRoot)
    if (turn) {
      // 同一 turn 只交付一次（信封一旦闭合，poll 每拍都会重新命中同一份 DOM）。
      if (dedup.seenTurnIds.includes(turn.turnId)) { dedup._hitTurnDup = (dedup._hitTurnDup || 0) + 1; return null }
      dedup.seenTurnIds.push(turn.turnId)
      return {
        kind: 'turn',
        turnId: turn.turnId,
        blocks: turn.blocks,
        turnDone: true,
        awaiting: turnAwaiting(turn.blocks),
        rotate: turnRotate(turn.blocks),
        errors: turn.errors || [],
      }
    }
    // [legacy-plain-removed-v1] 有回复容器却读不出信封 ⇒ 按契约整轮丢弃，**只记诊断**。
    //   [WHY 必须记] 这是「AI 写了东西、工作台却一片空白」的唯一服务端痕迹：turnMiss 持续增长
    //   = 模型一直没写围栏（或写得不能被 parseTurn 解析）。旧架构会在这里回落成 plain 卡——
    //   那正是「不写围栏也能显示」的旁路，也正是 2026-10-20 用户看到的「总结跑进正文就再无回传」形态。
    dedup._hitTurnMiss = (dedup._hitTurnMiss || 0) + 1
  }
  // [legacy-marks-removed-v1] 旧架构已整体删除：首行标记扫描（scanReplyMarks / findNewDone /
  //   markedNonScript）、DONE 门、以及把页面正文反推成 kind:"plain" 的整条交付链路。
  //   与油猴侧 [legacy-marks-removed-v1] 同批，两侧口径不再分叉。
  // [WHY 必须删] 契约 §1：回复只能是 ```json 围栏包住的 turn 信封，裸文本与无围栏代码一律整轮丢弃。
  //   旧 plain 路径把「从 DOM 反推出的正文」推给前端渲染，等于给契约开了一条永久旁路——
  //   模型只要不写围栏，反而能绕过块交付直接显示文本（而其中的脚本永远不执行）。
  // [script-fence-guess-removed-v1] 更早前已删「按 ```lang 围栏猜脚本」：脚本意图只能由
  //   信封的 content[].type 决定，按围栏语言猜会让 AI 正文里的示例代码被真执行（用户实测）。
  // [CHANGE-IMPACT] 本函数不再产出 kind:"script" / kind:"done" / kind:"plain"。
  //   ASK 提问卡改由信封的 ask 块承载（前端 timeline-build 按块渲染，不再 parseAsk 文本）；
  //   读不出信封 = 本轮没有合规内容 ⇒ 返回 null 等下一拍，由 readTurnBlocks 在闭合时交付。
  return null
}
