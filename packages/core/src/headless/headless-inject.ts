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
    w.__aiRunnerDedup = { seenHashes: [], seenDoneMarkers: [], lastBodySig: '', _pendingScriptHash: null, _pendingDoneSig: null, _plainSentInCycle: false, _shortSentHash: '' }
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
    w.__aiRunnerDedup = { seenHashes: [], seenDoneMarkers: [], lastBodySig: '', _pendingScriptHash: null, _pendingDoneSig: null, _plainSentInCycle: false, _shortSentHash: '' } // [fix-reply-dedup] [fix-plain-once] [short-reply-gate-v1]
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
  if (typeof dedup._seenGrowth !== 'boolean') dedup._seenGrowth = false
  if (typeof dedup._stableCount !== 'number') dedup._stableCount = 0
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

  // [code-text-clean-v1] 从 <code class="language-xxx"> 直接判语言
  // [WHY] DeepSeek 代码块头的语言标签/复制按钮不进入 <code> 元素，取 className 比邻近 DOM 探测更可靠
  // [CONSTRAINT] 只认 js/bash 两种（与 extractLatestScript 白名单一致），其余返回 null 交给后续探测
  // [CHANGE-IMPACT] 与 guessLangFromDom / guessLangFromContent 组成三级回退，改单级不影响其他级；
  //                与 scripts/tampermonkey-session-id.user.js 同名函数保持同步，避免双通道行为分叉
  function guessLangFromClass(el: Element | null): string | null {
    if (!el || !el.className) return null
    const m = String(el.className).match(/(?:language|lang)-([a-z0-9+#-]+)/i)
    if (!m) return null
    const raw = m[1].toLowerCase()
    if (raw === 'bash' || raw === 'sh' || raw === 'shell' || raw === 'zsh') return 'bash'
    if (raw === 'js' || raw === 'javascript' || raw === 'node' || raw === 'mjs' || raw === 'cjs') return 'js'
    return null
  }
  function guessLangFromDom(pre) {
    let sib = pre.previousElementSibling
    for (let i = 0; i < 3 && sib; i++, sib = sib.previousElementSibling) {
      const r = langFromText(sib.textContent)
      if (r) return r
    }
    const wrap = pre.closest('[class*="code"], [class*="md"], [class*="markdown"], [class*="block"]')
    if (wrap) {
      const cands = wrap.querySelectorAll('[class*="lang"], [class*="header"], [class*="title"], [class*="label"]')
      for (const c of cands) {
        const r = langFromText(c.textContent)
        if (r) return r
      }
    }
    return null
  }

  function guessLangFromContent(text) {
    const head = text.slice(0, 300)
    if (/^#!\s*\/usr\/bin\/env\s+bash/.test(head) || /^#!\s*\/bin\/bash/.test(head)) return 'bash'
    if (/^#!\s*\/usr\/bin\/env\s+node/.test(head)) return 'js'
    if (/\brequire\s*\(/.test(head)) return 'js'
    if (/\bmodule\.exports\b/.test(head)) return 'js'
    if (/\bprocess\.(?:exit|argv|env)\b/.test(head)) return 'js'
    // [js-content-broaden-v1] 补常见 Node/fs/语法特征（与 tampermonkey-session-id.user.js 保持同构）
    // WHY: 千问等站点直接输出 `fs.readdirSync(...)` / `const x = ...` 无 require → 旧特征全 null → 代码块被跳过降级为 plain 文本
    // CONSTRAINT: 只加高置信特征；避免误伤纯 JSON/配置代码块
    if (/\bfs\.(?:readFileSync|writeFileSync|readdirSync|existsSync|statSync|mkdirSync|unlinkSync)\b/.test(head)) return 'js'
    if (/\bconsole\.log\s*\(/.test(head)) return 'js'
    if (/\bJSON\.(?:parse|stringify)\s*\(/.test(head)) return 'js'
    if (/^(?:const|let)\s+\w+\s*=/.test(head)) return 'js'
    if (/^\s*(?:echo|cd\s|ls\s|mkdir|git\s|pnpm\s|npm\s|yarn\s|rm\s)/m.test(head)) return 'bash'
    if (/\bif\s+\[\s/.test(head) || /\bfi\b/.test(head) || /\$\(/.test(head)) return 'bash'
    return null
  }

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

  // [script-fence-gate-v1] 判定 SCRIPT 标记存在但本回复从未推出过有效 js 代码块（裸写无围栏 / 块未被识别为 js）。
  // 返回 'report'（首次报 error）| 'suppress'（已报过，抑制 plain 噪音）| 'none'（无需处理）。
  // [WHY] 旧逻辑让 SCRIPT+无有效块的回复落到 plain 分支 → 前端收一张只有"SCRIPT"文本或裸代码的卡 → 静默空转。
  // [CONSTRAINT] **必须内联在 detectReplyInPage 内部**：本函数经 page.evaluate 序列化到浏览器执行，
  //   顶层引用会随模块边界丢失（ReferenceError: decideScriptFence is not defined，实测 2026-10-14），
  //   与本文件内 hasUnclosedStructureJs / scanReplyMarks 的既有内联模式一致。
  // [CHANGE-IMPACT] 调用方负责"正文已稳定"前提（headless: _stableCount>=3；油猴: 已出 isGenerating 分支），本函数不重复判稳定。
  function decideScriptFence(scriptMarkPositive, seenHashesLen, alreadyReported) {
    if (!scriptMarkPositive) return 'none'
    if (seenHashesLen > 0) return 'none' // 已成功推过脚本：走噪音抑制，不报 fence
    if (alreadyReported) return 'suppress'
    return 'report'
  }

  function extractLatestScript() {
    // [script-closure-gate-v1] 结构闭合门 —— 未闭合的块不当作完整脚本推送。
    // [WHY] 此前唯一屏障是调用方的稳定判据（2 帧同 hash / 油猴 350ms 防抖 + 生成中门），两者都只要求「文本没变」、
    //   不要求块闭合 ⇒ 任何超窗停顿都让半截块被判完整，下游报 `Unexpected end of input`（与 max_tokens 截断同形）。
    // [CONSTRAINT] 只延迟、不丢弃：连续 CLOSURE_ACCEPT_TICKS 次不变仍未闭合 ⇒ 判为真截断，照旧放行；
    //   门状态挂 window（不用 dedup）⇒ 双通道逐字同构；扫描器语义须与 post-run/script-check.ts 的 hasUnclosedStructure 一致（语料对拍）。
    function hasUnclosedStructureJs(src) {
      const stack = []
      let state = 'code'
      for (let i = 0; i < src.length; i++) {
        const ch = src[i]
        const nx = src[i + 1]
        if (state === 'line-comment') { if (ch === '\n' || ch === '\r') state = 'code'; continue }
        if (state === 'block-comment') { if (ch === '*' && nx === '/') { state = 'code'; i++ } continue }
        if (state === 'single' || state === 'double' || state === 'template') {
          const q = state === 'single' ? '\'' : state === 'double' ? '"' : '`'
          if (ch === '\\') { i++; continue }
          if (ch === q) state = 'code'
          continue
        }
        if (ch === '/' && nx === '/') { state = 'line-comment'; i++; continue }
        if (ch === '/' && nx === '*') { state = 'block-comment'; i++; continue }
        if (ch === '\'') { state = 'single'; continue }
        if (ch === '"') { state = 'double'; continue }
        if (ch === '`') { state = 'template'; continue }
        if (ch === '{' || ch === '(' || ch === '[') { stack.push(ch); continue }
        if (ch === '}' || ch === ')' || ch === ']') {
          const want = ch === '}' ? '{' : ch === ')' ? '(' : '['
          if (stack.length === 0 || stack[stack.length - 1] !== want) return true
          stack.pop()
        }
      }
      if (state === 'single' || state === 'double' || state === 'template' || state === 'block-comment') return true
      return stack.length > 0
    }
    // [script-content-gate-v1] 脚本完整性门：剔除 shebang / 注释 / 空白后必须还有可执行内容。
    // [WHY] 括号闭合门对「只有头部注释」的文本天然为 false（注释里不含括号），流式中途任一停顿
    //   都会让半成品头部被判为完整脚本推出去 → 前端执行两次（2026-10-07 22:18:14 实测）。
    // [CONSTRAINT] 判据与 packages/client/composables/runner/inbox-parse.ts 的 normalizeForHash 同构；
    //   与 scripts/tampermonkey-session-id.user.js 的同名函数逐字同构，改一处必须同步另一处。
    function hasExecutableContent(src) {
      const stripped = String(src || '')
        .split('\n')
        .map(l => l.trim())
        .filter((l) => {
          if (!l) return false
          if (l.startsWith('#!')) return false
          if (l.startsWith('//')) return false
          if (l.startsWith('#')) return false
          return true
        })
        .join('')
      return stripped.length > 0
    }
    /** 正文长度变了 ⇒ 回复仍在增长，继续等；连续 3 次等长 ⇒ 判定为「上游真截断」并放行 */
    function stillStreamingReply() {
      const body = String((document.body && document.body.textContent) || '')
      const gate = window.__aiRunnerClosureGate
      if (!gate || gate.len !== body.length) {
        window.__aiRunnerClosureGate = { len: body.length, ticks: 0 }
        return true
      }
      gate.ticks++
      // [closure-timeout-v1] 放行瞬间打点：事后可区分「上游真截断被放行」与「完整块正常放行」
      // [CONSTRAINT] releasedAt 仅在此写入，被 detectReplyInPage 一次性消费后置 null
      if (gate.ticks >= 3) {
        gate.releasedAt = Date.now()
        return false
      }
      return true
    }
    // 只扫最后一条 assistant 消息，排除历史/用户消息
    // [no-root-no-reply-v1] 容器缺失 ⇒ 不扫整页（用户消息里的代码块会被当脚本候选；
    //   与油猴通道 latestAssistantRoot() 语义同构，假 DOM 对拍见 multi-script-blocks）
    const blocks = document.querySelectorAll('.ds-assistant-message-main-content')
    const root = blocks.length > 0 ? blocks[blocks.length - 1] : null
    const pres = root ? Array.from(root.querySelectorAll('pre')) : []
    // [multi-script-v1] 一条回复允许携带多个脚本：本函数每帧只放行**一个**尚未推送的块，
    //   由调用方的「连续 2 帧同 hash」稳定判据逐块送出，前端再串行执行。
    // [WHY] 旧实现 `lastMarked || last` 只取最后一块，前面所有块被**静默丢弃**；
    //   而最后一块恰恰是上游截断最可能切中的那一块 → 一整轮白跑（用户实测的「脚本被截断」）。
    // [CONSTRAINT] 仍优先取「带脚本头契约标记」的块（shebang / @desc），避免把正文里的示例代码当脚本；
    //   无标记块只在没有任何未见过的标记块时才兜底。seenHashes 去重保证同一块不会重复放行。
    const seenHashes = dedup.seenHashes
    let firstUnseen = null
    let firstUnseenMarked = null
    // [fragment-guard-v1] 本回复内是否存在任意标记块（含已被 seen 记过的）——
    //   存在则无标记块一律视为说明性片段，不再兜底推送。
    let hasAnyMarked = false
    for (const pre of pres) {
      // [code-text-clean-v1] 优先从 <pre><code> 取文本，避开代码块头的语言标签与「复制/下载」按钮文字
      // [WHY] pre.textContent 会把头部按钮文字并入首行，污染后 #! 锚点失配、语言判定失败导致整块跳过
      // [CONSTRAINT] 无 code 子元素时回退 pre 本身；text 变量名保持，后续 hash/done 提取均复用同一字符串
      const codeEl = pre.querySelector('code') || pre
      const text = (codeEl.textContent || '').replace(/^\n+|\n+$/g, '')
      if (!text) continue
      if (!text.includes('\n') && text.length < 120) continue
      // [code-text-clean-v1] 语言判定三级回退：className → DOM 邻近探测 → 内容特征
      let lang = guessLangFromClass(codeEl) || guessLangFromDom(pre) || guessLangFromContent(text) || null
      // [script-head-contract-fallback-v1] 脚本头契约：shebang 或 @desc 注释是脚本强特征
      // [WHY] AI 有时用非白名单语言标签（如 ```javascript / ```node / 无标签），三级判定得 null → script 被漏识别 →
      //   前端只收到 plain 走渲染不执行。命中契约特征时兜底认定 js，让符合脚本头契约的脚本能被无差别识别
      // [CONSTRAINT] 只认脚本头契约允许的两种形式（shebang / @desc）；误伤面：AI 复述 SYSTEM.md 示例会被当成脚本候选，
      //   由 lastMarked 优先级与 dedup hash 共同约束
      // [CHANGE-IMPACT] 影响 detectReplyInPage 的 kind 分流：修复后符合契约的脚本块稳定走 script 分支
      const _marked = /^#!\s*\/usr\/bin\/env\s+(?:node|bash)\b/m.test(text)
        || /^\s*\/\/\s*@desc\b/m.test(text)
        || /^\s*#\s*@desc\b/m.test(text)
      if (!lang && _marked) lang = 'js'
      // [script-lang-whitelist-v2] 语言白名单收紧为 js / bash，并**取消**「首行声明 SCRIPT 即无条件放行」。
      // [WHY] 旧判据在白名单之外还挂了一个 declared 豁免开关：声明 SCRIPT 时连语言**判不出来**
      //   的块（```python / ```json / 无语言标签）也一并收下 → attach-ws 把 null 折算成 'js' →
      //   前端按 cjs 交给 node → 必然语法错，白烧一轮。合法脚本不受影响：脚本头契约（shebang / @desc）
      //   已由上方 _marked 兜底成 js，纯内容特征命中的块也各有 js/bash 归属。
      // [CONSTRAINT] 与 scripts/tampermonkey-session-id.user.js 的 extractLatestScript 逐字同构
      //   （守卫测试 reply-mark-parity）；本函数不再接收任何参数，调用处不得传 declared。
      // [CHANGE-IMPACT] 语言不可判定的声明块不再进 script 分支（降级为 plain 走 Markdown 渲染）；
      //   bash 仍可采集（供自动循环的 /exec 通道），但不再有「被当成 js 交给 /run」的错路。
      if (lang !== 'js' && lang !== 'bash') continue
      // [script-content-gate-v1] 非注释内容非空门：只有头部注释的残缺块不算完整脚本。
      // [WHY] 2026-10-07 22:18:14 实测：AI 流式中途只吐出 #! + @desc + @why + @plan 的头部，
      //   括号闭合门对纯注释天然返回 false ⇒ 被判「完整」推送 → 前端跑一次空脚本（1.53s），
      //   完整块到达后再跑一次（1.55s）→ 用户看到同 desc 执行两次（间隔 1.8s）。
      if (!hasExecutableContent(text)) continue
      // [script-closure-gate-v1] 未闭合 ⇒ 极可能仍在流式生成中途（或站点把回复切断了）：
      //   继续等下一帧；只有「正文长度连续 N 次不变」才判定为上游真截断并放行（约束见函数头）
      if (hasUnclosedStructureJs(text)) {
        if (stillStreamingReply()) continue
      }
      let _h
      const _cached = dedup._preCache.get(pre)
      if (_cached && _cached.len === text.length) { _h = _cached.hash }
      else { _h = hash32(text); dedup._preCache.set(pre, { len: text.length, hash: _h }) }
      const item = { lang, code: text, hash: _h }
      // [fragment-guard-v1] marked 须在 seen 跳过**之前**计算：
      //   已推送过的标记块也要计入 hasAnyMarked（否则第二次 pick 会误判「本回复无标记块」而兜底推片段）。
      const marked = /^#!\s*\/usr\/bin\/env\s+(?:node|bash)\b/m.test(text)
        || /^\s*\/\/\s*@desc\b/m.test(text)
        || /^\s*#\s*@desc\b/m.test(text)
      if (marked) hasAnyMarked = true
      // [multi-script-v1] 已推送过的块不再参与选取，否则「首个未见」会永远卡在同一块上
      if (seenHashes.includes(_h)) continue
      if (!firstUnseen) firstUnseen = item
      if (marked && !firstUnseenMarked) firstUnseenMarked = item
    }
    if (firstUnseenMarked) return firstUnseenMarked
    if (hasAnyMarked) return null
    return firstUnseen
  }

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

  // [reply-mark-v1] 标记行优先：先算首行标记，再决定是否走 DOM 结构判定。
  // [WHY] 带 ASK / DONE / HANDOFF 标记的回复若含代码块，旧逻辑会被 script 分支抢走（script 判定排在 done/plain 之前）
  //   → DONE 总结里的示例代码块会被当脚本重新执行。[CONSTRAINT] extractReplyMd 是 DOM→Markdown 反推（保留换行），
  //   getMainText 的 textContent 无换行、无法用于「首行」判定，故标记扫描一律基于前者。
  const replyBlocks = document.querySelectorAll('.ds-assistant-message-main-content')
  // [no-root-no-reply-v1] 容器不存在（新会话首轮「已思考/搜索」期）⇒ replyRoot 置 null：extractReplyMd(null) 返回空串、
  //   marks 全 -1、getMainText() 返回空。原「兜底成 document」会把侧栏历史会话标题（未知标签递归 inner() 拼成连体乱文）
  //   + 用户首条消息卡反推成「回复」推给前端（2026-10-08 18:53 两张噪音卡根因，油猴通道同日同修）。
  const replyRoot: Element | null = replyBlocks.length > 0 ? replyBlocks[replyBlocks.length - 1] : null
  const marks = scanReplyMarks(extractReplyMd(replyRoot))
  const markedNonScript = marks.ask > 0 || marks.done > 0 || marks.handoff > 0 || marks.text > 0

  // [stopped-no-autorun-v1] 本轮已推过 stopped ⇒ 不再推送残余脚本块（与 plain 抑制同一生命周期）。
  // [WHY] 前端收 stopped 会 finish 整个循环；此后该回复里的闭合代码块若仍被推出，循环已非活动 ⇒
  //   前端 `autoTakeover.scheduleAutoRun`（无条件立即执行）会把它跑掉，形成无记账、无自检、无预算反馈的
  //   「循环外自动执行」旁路（WO-20261005 段三判定为缺陷）。_stoppedReported 随 fill 轮次重置，新一轮脚本不受影响。
  // [parity] scripts/tampermonkey-session-id.user.js classifyAndPost 有同构守卫（stopPosted 标志）
  const stoppedThisRound = Boolean(dedup._stoppedReported)

  // script 需连续 2 次相同 hash 才推，避开流式中途残缺
  // [script-lang-whitelist-v2] 不再传 declared：语言白名单恒为 js/bash（见 extractLatestScript）
  const script = markedNonScript || stoppedThisRound ? null : extractLatestScript()
  // [generating-gate-v1] 无头通道补「生成中门」（与油猴 350ms 防抖 + 生成中门 parity）。
  // [WHY] 原判据是三层弱条件叠加（2 帧同 hash + hasUnclosedStructureJs 结构闭合 + stillStreamingReply 用 body.length 判稳定），
  //   三者都是「必要不充分」却被当充分条件 ⇒ AI 写完完整函数后停顿 >800ms（或思考期长度不变 3 帧）即误推脚本。
  // [CONSTRAINT] 只拦「有脚本块 + 生成中」；markedNonScript（DONE/ASK/TEXT）不受影响（否则 DONE 首行写在生成中会被推迟）。
  // [CONSTRAINT] 清 _pendingScriptHash 避免生成完成后因 hash 相同直接跳过 2 帧判据；isGeneratingInPage 失配 fail-open（不误判生成中）。
  // [CHANGE-IMPACT] 站点改版致探针恒 false 时退化为原三层判据（非「永不放行」）。
  if (script && isGeneratingInPage()) {
    dedup._pendingScriptHash = null
    return null
  }
  if (script && !dedup.seenHashes.includes(script.hash)) {
    if (dedup._pendingScriptHash === script.hash) {
      dedup._pendingScriptHash = null
      dedup.seenHashes.push(script.hash)
      dedup.lastBodySig = bodySignature()
      const gateNow = window.__aiRunnerClosureGate
      if (gateNow && gateNow.releasedAt) {
        const info = { closureRelease: true, closureTicks: gateNow.ticks, closureLen: gateNow.len }
        gateNow.releasedAt = null
        return { kind: 'script', code: script.code, lang: script.lang, hash: script.hash, ...info }
      }
      return { kind: 'script', code: script.code, lang: script.lang, hash: script.hash }
    }
    dedup._pendingScriptHash = script.hash
    return null
  }

  const doneMarker = findNewDone()
  if (doneMarker) {
    // [done-gate-v1] 生成中不推（首行 DONE 可能流式中途出现）+ 2 帧稳定门兜底（marker 在 summary<200 字时随流式变）。2026-10-17 实测「分两段」真根因是缺前门。
    if (isGeneratingInPage()) return null
    const _doneSig = bodySignature()
    if (dedup._pendingDoneSig !== _doneSig) {
      dedup._pendingDoneSig = _doneSig
      return null
    }
    dedup._pendingDoneSig = null
    dedup.seenDoneMarkers.push(doneMarker.marker)
    dedup.lastBodySig = _doneSig
    return { kind: 'done', text: doneMarker.text } // [done-plain-v1] 允许纯 Markdown 总结
  }

  // 文本稳定检测：连续 3 次 body 不变 → 生成结束，推 plain + text
  dedup._hitSig2 = (dedup._hitSig2 || 0) + 1
  const sig2 = bodySignature()
  if (sig2 !== dedup.lastBodySig) {
    dedup._hitSigChanged = (dedup._hitSigChanged || 0) + 1
    dedup.lastBodySig = sig2
    dedup._stableCount = 0
    dedup._seenGrowth = true
    return null
  }
  if (!dedup._seenGrowth) { dedup._hitNoGrowth = (dedup._hitNoGrowth || 0) + 1; return null }
  // [ask-any-cycle-v1] ASK 标记不受「本轮已推过 plain」约束：
  //   流式回复常先出无标记文本（被推成 plain）再补 ASK 块，若一并被去重拦下，提问卡永不出现。
  //   ASK 分支本身有 _stableCount>=3 稳定门槛，重复推的风险由该门槛承担。
  if (dedup._plainSentInCycle && marks.ask < 0) { dedup._hitPlainSent = (dedup._hitPlainSent || 0) + 1; return null }
  dedup._stableCount = (dedup._stableCount || 0) + 1
  if (dedup._stableCount < 3) { dedup._hitStableLow = (dedup._hitStableLow || 0) + 1; return null }
  const plainText = getMainText()
  // [reply-mark-v1] 复用开头算好的 marks（与脚本判定同一口径，避免漂移）：HANDOFF / ASK / TEXT 放行，其余纯文本拦下；
  //   [CONSTRAINT] 不能用 getMainText() 的 textContent 做标记扫描（无换行 ⇒ 整段被当「一行」，首行标记判据必失配）。
  // [short-reply-gate-v1] 极短（去空白 <6 字）无标记回复不再恒丢：生成中或静止窗 <6tick ⇒ 等，否则交付。
  // [WHY] 2026-10-18 实测「只回复两个字：收到」：body 铁定稳定（_stableCount=129）仍被旧闸门每 tick 丢弃 ⇒ 整轮无回复到 15s 告警。
  // [CONSTRAINT] 交付不置 _plainSentInCycle（可能只是长回复前缀，锁死会让后续真答复被 _hitPlainSent 吞掉），去重用 _shortSentHash；
  //   本轮已推过 stopped 时整闸门不参与（短文本同属「停止后补发」，先交付会绕开下方 stopped 守卫）。
  if (marks.ask < 0 && marks.handoff < 0 && marks.text < 0 && !dedup._stoppedReported && !hasJsFence(plainText)) {
    const _bare = plainText.replace(/\s+/g, '').length
    const _h = _bare > 0 && _bare < 6 ? hash32(`short|${plainText}`) : ''
    // [headless-collector-v1] _stableCount < 6 已退役：新模型由 waitForSignal 的静默窗（≥400ms）保证稳定，
    //   轮询时代的「连续拍数」补偿意义消失。保留 isGeneratingInPage() 那一半——它防的是
    //   「生成中推半截」，与唤醒机制无关；短回复去重仍由 _shortSentHash 承担。
    if (_h && isGeneratingInPage()) { dedup._hitShortGate = (dedup._hitShortGate || 0) + 1; return null }
    if (_h && dedup._shortSentHash !== _h) {
      dedup._shortSentHash = _h; dedup._hitShortPass = (dedup._hitShortPass || 0) + 1
      return { kind: 'plain', text: plainText }
    }
    if (_h) { dedup._hitShortDup = (dedup._hitShortDup || 0) + 1; return null }
  }
  // [stopped-plain-noise-v1] 本轮已推过 stopped ⇒ 之后的 plain 必为「已停止」半截回复的补发，跳过。
  // [WHY] stopped 分支只推一次（_stoppedReported 置位），但停止横幅插入/按钮态变化仍会让 body 稳定判据（_stableCount>=3）
  //   走到 plain 分支，把半截回复全文补发 ⇒ 前端多一张巨大文本卡（2026-10-08 实测）。[script-plain-noise-v1] 的 marks.script
  //   守卫拦不住它（首行是普通文本）。_stoppedReported 随 fill 轮次重置，新一轮真实 plain 不受影响；油猴 stopPosted 同构。
  if (dedup._stoppedReported) { dedup._hitStopped = (dedup._hitStopped || 0) + 1; return null }
  // [script-plain-noise-v1] 首行 = SCRIPT 且本会话已成功推过脚本 ⇒ plain 必为噪音，跳过。
  // [WHY] 按输出契约，SCRIPT 首行的回复「第二行起是代码块、块外零字符」，没有可展示正文；脚本已由上面的 script 分支推送，
  //   此后 body 稳定（_stableCount>=3）到达此处会把整条回复反推全文（裸标记行 + 已推围栏）再发一遍
  //   ⇒ 前端多一张正文只有「SCRIPT」的卡（stripScriptBlocks 剥不掉裸标记行）。
  // [CONSTRAINT] 要求已推过脚本才跳过：脚本从未推成功时保留旧 plain 行为，避免「AI 说了话但应用端毫无反应」不可观测（油猴同构）。
  if (marks.script > 0 && dedup.seenHashes.length > 0) { dedup._hitScriptNoise = (dedup._hitScriptNoise || 0) + 1; return null }
  // [script-fence-gate-v1] SCRIPT 标记存在但本回复从未推出有效脚本块（body 已稳定，见上方 _stableCount>=3）⇒
  //   这是「裸写代码无围栏」或「代码块未被识别为 js」的静默失败：立即报 error 而非降级 plain 文本卡。
  // [CONSTRAINT] 用 dedup._scriptFenceReported 去重只报一次；已推过脚本（seenHashes 非空）走上方噪音抑制。
  // [CONSTRAINT] error kind 前端渲染为 toast 并让循环继续（类 BASH_CHANNEL_REMOVED，exit 2 不终止）。
  const _fence = decideScriptFence(marks.script > 0, dedup.seenHashes.length, dedup._scriptFenceReported)
  if (_fence === 'report') {
    dedup._scriptFenceReported = true
    return { kind: 'error', text: 'SCRIPT 载荷不是有效的 js/cjs 代码块：必须用 ```js 围栏包裹代码，且脚本头用 // @desc / // @why（参考 packages/core/SYSTEM.md §1 状态 A）。' }
  }
  if (_fence === 'suppress') { dedup._hitFenceSuppress = (dedup._hitFenceSuppress || 0) + 1; return null }
  dedup._plainSentInCycle = true
  // [text-mark-v1] TEXT 标记的载荷：取 DOM→Markdown 反推正文并剥掉标记行。
  // [WHY] getMainText() 是 textContent——块级标签之间不插换行，标记行会与正文粘成一行，
  //   前端 renderMarkdown 拿到的是「TEXTxxx」一整段，段落/列表全塌。
  // [ask-card-newline-v1] ASK 标记回复同样必须用 extractReplyMd 保留换行。
  // [WHY] 与 TEXT 同坑（见下）：getMainText 的 textContent 无换行，前端 parseAsk 的
  //   「首个非空行 = 独占标记行」判据失配 → askUser 不触发 → ai:question 不入流 → 提问卡不渲染。
  // [CONSTRAINT] 传 extractReplyMd(replyRoot) 原样（不剥标记行）：parseAsk 需按标记行定位问题正文。
  if (marks.ask > 0) {
    return { kind: 'plain', text: extractReplyMd(replyRoot) }
  }
  if (marks.text > 0) {
    const body = extractReplyMd(replyRoot).split(/\r?\n/).slice(marks.text).join('\n').trim()
    return { kind: 'plain', text: body || plainText }
  }
  return { kind: 'plain', text: plainText }

  return null
}
