/* eslint-disable ts/no-unused-vars, unused-imports/no-unused-vars -- 兼容 fs API 签名 / catch 兼容 */
// ==UserScript==
// @name         AI Runner · 会话 ID + 用量估算 + 回复回传 + fill 接收
// @namespace    ai-runner
// @version      1.9.3
// @description  回传会话 ID/用量/AI 回复到工作台；[fragment-guard-v1]；接收 fill/stop；[reply-mark-v1] 回复标记统一为「首行标记行 + 第二行起载荷」：SCRIPT / ASK / DONE / HANDOFF（@ask、# 任务 保留为过渡别名）
// @match        https://chat.deepseek.com/*
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @match        https://claude.ai/*
// @match        https://kimi.moonshot.cn/*
// @match        https://gemini.google.com/*
// @match        *://*.qianwen.com/*
// @match        *://*.qianwen.ai/*
// @match        *://*.aliyun.com/*
// @match        *://*.tongyi.cn/*
// @match        *://*.qianwen.cn/*
// @match        https://chatglm.cn/*
// @run-at       document-idle
// @grant        none
// @updateURL    http://127.0.0.1:5178/tampermonkey-session-id.user.js
// @downloadURL  http://127.0.0.1:5178/tampermonkey-session-id.user.js
// ==/UserScript==
(function () {
  'use strict'

  const RULES = [
    { re: /chat\.deepseek\.com\/a\/chat\/s\/([\w-]+)/, n: 1 },
    { re: /chatgpt\.com\/c\/([\w-]+)/, n: 1 },
    { re: /chat\.openai\.com\/c\/([\w-]+)/, n: 1 },
    { re: /claude\.ai\/chat\/([\w-]+)/, n: 1 },
    { re: /kimi\.moonshot\.cn\/chat\/([\w-]+)/, n: 1 },
    { re: /gemini\.google\.com\/app\/([\w-]+)/, n: 1 },
    { re: /tongyi\.aliyun\.com\/qianwen\/([\w-]+)/, n: 1 },
    { re: /qianwen\.aliyun\.com\/[\w-]*\/?([\w-]{20,})/, n: 1 },
    // [qianwen-web-v1] 千问网页版（qianwen.com）会话 URL 规则
    // WHY: 主域名切换至 qianwen.com，会话形如 /chat/{id} 或 /c/{id} 或 /q/{id}
    // CONSTRAINT: 域名锚定 qianwen.com，避免误匹配其他站点；顺序置末尾保留既有优先级
    // CHANGE-IMPACT: 影响 extractId() 返回；未命中返回 ''，不影响其他站点
    { re: /(?:www\.)?qianwen\.com\/(?:chat|c|q)\/([\w-]+)/, n: 1 },
    // [chatglm-adapter-v1] 智普清言会话 URL：/main/detail/{id}
    { re: /chatglm\.cn\/main\/detail\/([\w-]+)/, n: 1 }
  ]

  // [replay-buf] 缓存最近 N 条外发消息，供刷新后重放
  const _msgBuf = []
  const _MSG_BUF_MAX = 50
  // [c1-bridge-v1] 消息去重（msgId）+ 断链队列 + 定期 drain
  let _msgSeq = 0
  // [fill-dedup-v1] 入站 fill/rotate 去重，防止 postMessage 重试/多窗口重复消费
  const _seenInbound = new Set()
  const _pending = []
  const _PENDING_MAX = 200
  function _nextMsgId() {
    _msgSeq = (_msgSeq + 1) >>> 0
    return `${Date.now().toString(36)}-${_msgSeq.toString(36)}`
  }
  function _trySend(p) {
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(p, '*')
        return true
      }
    } catch { /* ignore */ }
    return false
  }
  function post(payload) {
    if (!payload || typeof payload !== 'object') return
    if (!payload.msgId) payload.msgId = _nextMsgId()
    if (!payload.ts) payload.ts = Date.now()
    _msgBuf.push(payload)
    if (_msgBuf.length > _MSG_BUF_MAX) _msgBuf.shift()
    if (!_trySend(payload)) {
      _pending.push(payload)
      if (_pending.length > _PENDING_MAX) _pending.shift()
    }
  }
  function _drainPending() {
    if (!_pending.length) return
    if (!window.opener || window.opener.closed) return
    const items = _pending.splice(0, _pending.length)
    for (const p of items) _trySend(p)
  }
  setInterval(_drainPending, 1000)

  // [fill-ack-v1] fill 回执：所有失败/跳过路径必须回 ack，否则客户端 sendFillToAsync 无法感知丢帧
  // [WHY] 新窗口场景站点加载 >1.5s 时油猴已注入但输入框未渲染，旧实现 console.warn 后静默 return
  // [CONSTRAINT] reason 是短枚举字符串；sid 由 URL hash 取，客户端按 sid 匹配最近一条 ack
  function ackFill(ok, reason, ackId) {
    post({ type: 'ai-runner:fill-ack', ok: Boolean(ok), reason: String(reason || ''), ackId: String(ackId || ''), sid: extractSidFromHash() })
  }

  let lastId = ''
  let lastSid = ''
  // [session-boot-v1] 本油猴实例是否已报告过「启动」：
  //   仅首次 send() 携带 boot:true，供客户端识别 AI 窗口刚加载（新上下文）；
  //   F5 后新实例会重新置 false，站点内切会话触发的后续 send() 不带该标记。
  let _bootSent = false

  function extractSidFromHash() {
    const m = location.hash.match(/(?:^#|&)sid=([\w.-]+)/)
    return m ? m[1] : ''
  }

  function extractId() {
    const href = location.href
    for (let i = 0; i < RULES.length; i++) {
      const m = href.match(RULES[i].re)
      if (m) return decodeURIComponent(m[RULES[i].n])
    }
    return ''
  }

  // [assistant-root-v1] 定位「最后一条 AI 回复」的容器，站点无关
  // WHY: 原实现硬编码 DeepSeek 的 .ds-assistant-message-main-content；
  //   千问（.chat-answers-card-wrap）等站点取不到 → 文本退回整页 document，
  //   而整页末 300 字符是输入框/页脚，AI 流式期间不变化 → 回复签名恒定 → 永不回传
  // CONSTRAINT: 按特异性从上到下取最后一个命中元素；全不命中返回 null 由调用方兜底为 document
  // CHANGE-IMPACT: findNewDone / extractLatestReplyText / bodySignature 三处共用
  const ASSISTANT_ROOT_SELECTORS = [
    '.ds-assistant-message-main-content', // DeepSeek
    '[data-message-author-role="assistant"]', // ChatGPT
    '.chat-answers-card-wrap', // 千问 / 通义
    // [chatglm-adapter-v2] 智普清言对话页：原 .conversation-item .answer-content 未实测（[chatglm-adapter-v1] 标注"真实 DOM 快照"来源不明），
    //   实测症状「能发不能回」= 该选择器 miss → latestAssistantRoot 返回 null → bodySignature 退化为全页末 300 字符
    //   （智谱页面末 300 字符 = 输入框 + 页脚，流式期间恒定）→ hash 恒定 → 永不 post。与 L111-113 注释记载的「签名恒定→永不回传」同根因。
    //   改为三候选：保留原值 + answer-content 类名前缀变体 + answer-body 变体。
    // [CONSTRAINT] 本条必须排在数组末位（顺序即优先级，latestAssistantRoot 取第一个非空命中）。
    // [CHANGE-IMPACT] 若仍 miss，用户侧探针数字可继续收窄；不影响前三条站点选择器。
    '.conversation-item .answer-content, [class*="answer-content"], [class*="answer-body"]',
  ]
  function latestAssistantRoot() {
    for (let i = 0; i < ASSISTANT_ROOT_SELECTORS.length; i++) {
      const els = document.querySelectorAll(ASSISTANT_ROOT_SELECTORS[i])
      if (els.length > 0) return els[els.length - 1]
    }
    return null
  }

  function send() {
    const id = extractId()
    const sid = extractSidFromHash()
    let changed = false
    if (id && id !== lastId) { lastId = id; changed = true }
    if (sid !== lastSid) { lastSid = sid; changed = true }
    if (!changed) return
    // [session-boot-v1] 首发行携带 boot 标记；无论 opener 是否就绪都置位，
    //   避免 opener 未建立时反复被后续 send() 判为「首发」。
    const _isBoot = !_bootSent
    _bootSent = true
    try {
      if (window.opener && !window.opener.closed) {
        post({ type: 'ai-runner:session-id', id, sessionId: extractSidFromHash(), boot: _isBoot })
      }
    } catch {}
  }

  send()

  let lastHref = location.href
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href
      send()
    }
  }, 500)

  let domTimer = null
  const observer = new MutationObserver(() => {
    if (domTimer) clearTimeout(domTimer)
    domTimer = setTimeout(send, 800)
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  // [c1-bridge-v1] body 存活检查（DOM 容错，detached 时重挂）
  setInterval(() => {
    if (!document.body || !document.body.isConnected) return
    try { observer.observe(document.body, { childList: true, subtree: true, characterData: true }) } catch { /* ignore */ }
  }, 3000)

  window.addEventListener('popstate', send)
  window.addEventListener('hashchange', send)

  // ===== 回复回传 =====
  function hash32(s) {
    let h = 0x811C9DC5
    for (let i = 0; i < s.length; i++) {
      h = Math.imul(h ^ s.charCodeAt(i), 0x1000193) >>> 0
    }
    return (h >>> 0).toString(16).padStart(8, '0')
  }

  // [script-fence-gate-v1] 与 headless-inject.ts detectReplyInPage 同构（守卫测试 script-fence-gate）
  // 返回 'report' | 'suppress' | 'none'；纯函数、无 DOM/闭包依赖
  function decideScriptFence(scriptMarkPositive, seenHashesLen, alreadyReported) {
    if (!scriptMarkPositive) return 'none'
    if (seenHashesLen > 0) return 'none'
    if (alreadyReported) return 'suppress'
    return 'report'
  }
  const seenHashes = new Set()
  const seenDoneMarkers = new Set()
  let lastBodySig = ''
  // [done-stable-gate-v1] DONE 分支的 2 帧稳定门（与 headless-inject.ts 同构）。
  // [WHY] marker 是 hash(`done-head|${summary.slice(0,200)}`)；短内容时前 200 字随流式变化 ⇒
  //   去重失效 ⇒ 同一 DONE 被推 N 次（2026-10-17 用户实测）。
  let _pendingDoneSig = null
  let _scriptFenceReported = false
  // [stopped-btn-v1] stopped 分支的回传文案。[stopped-toast-quote-v1] 的「带命中原文」机制随
  //   全文关键词探针一起废止（按钮驱动后没有正文命中可带；原文通道的自指风险见该 tag 历史：
  //   停机态文案与 UI 文案同形，2026-10-10 14:14 实测页面一切正常却弹停止提示）。
  // [CONSTRAINT] 兜底值必须**分段拼接**：整句字面量会成为探针源码的自命中。
  const STOPPED_GENERIC = 'AI 网页' + '已停止' + '生成'
  // [stopped-plain-noise-v1] 本轮是否已推过 stopped：置位后 plain 分支不再补发半截回复
  // （与 headless-inject.ts 的 dedup._stoppedReported 同义；随 fill/rotate 轮次重置）
  let stopPosted = false
  // [stopped-btn-v1] 按钮状态驱动的停止检测（替代全文关键词 countStopMarkers）：
  //   不再扫描「已停止生成/回答/输出」等文本关键词（AI 讨论探针本身时会在正文里自指命中
  //   → 误推 stopped → 后续脚本被 stopped-window 闸门拦截）。
  //   改为追踪「停止按钮」状态变化：
  //   - prevGenerating：上一轮 classifyAndPost 看到的按钮状态（true=存在且可点）
  //   - genEnterRoots：进入 generating 状态时的 assistant 根数量
  //   - genEnterRootId：进入 generating 时最后一个 assistant 根的身份指纹（[stopped-btn-v2]）
  //   判据：prevGenerating===true + 当前!isGenerating + roots 未增长且最后根身份未变 = 真中断
  let prevGenerating = false
  let genEnterRoots = 0
  let genEnterRootId = '' // [stopped-btn-v2] 与 genEnterRoots 同时记录，见 rootsFrozenNow
  // [limit-posted-v1] 本轮是否已推过 limit：**存量兜底通道（limitStale）每轮恒真**，
  //   而「更新 limitMarkerBaseline」压不住它 —— 该通道不依赖计数增长，基线更新前后恒真
  //   ⇒ 每轮 classifyAndPost 都会再 post 一次 kind:'limit'（2026-10-10 15:07 用户实测：
  //   toast 队列被 MAX_VISIBLE=3 打满，稳态交替 [warn,info,warn] / [info,warn,info]）。
  // （与 headless-inject.ts 的 dedup._limitReported 同义；随 fill/rotate 轮次重置）
  // [WHY] headless 侧早有该旗标（:172 守卫 / :180 置位），油猴侧从未同步 ——
  //   这是 2026-10-10 同一天内第三次撞上「headless 有、油猴没有」（前两次：回传命中原文、冷启动基线）。
  // [CONSTRAINT] **只压「存量兜底」通道**；「计数增长」通道自限、不 gate ——
  //   否则一次误报就把本轮后续的**真**触顶信号一起挡死。
  let limitPosted = false
  // [stopped-detect-v3] 冷启动守卫：首个 fill/rotate 发生前，「本轮增量」探测器一律只记基线、不报。
  // [WHY] DeepSeek 的「已停止」角标会**永久留在历史消息下方**；页面刷新会清空本脚本全部运行态
  //   （基线归 0、stopPosted 归 false），而 replyObserver 在脚本注入即连接（见下方 resumeReplyObserver()
  //   的顶层调用）⇒ 历史恢复把旧角标带回 DOM 的那一刻，classifyAndPost 就把「存量」当成「本轮新增」
  //   ⇒ 误报 kind:'stopped'（2026-10-10 15:20 用户实测：刷新后立即弹「本轮不再等待」，页面命中原文）。
  //   headless 侧同一缺陷已在 [stopped-detect-v2] 修复（detectReplyInPage 冷启动基线 = 当前存量），
  //   油猴侧此前从未同步 —— 本守卫即补齐。
  // [stopped-btn-v1] stopped 探针 2026-10-16 起按钮驱动（不再扫文本、无基线）⇒ 本守卫现只覆盖 limit。
  // [CONSTRAINT] 与 fill/rotate 的 syncLimitMarkerBaseline 同口径：基线只对「本轮新增」负责；
  //   首个 fill 之后本守卫永久失效。
  let _roundBaselinesReady = false
  // [limit-scan-strip-v1] 触顶/停止两类标记探针只扫「正文」：剥掉代码块、输入框与可编辑区。
  // [WHY] 工作台把脚本 stdout 用 ``` 围栏回填进会话（prompt-builder appendRawOutputs）⇒ 页面里落成
  //   <pre><code>，而源码/文档里含探针自己的词表（如 headless-inject-simple.ts 的
  //   `maximum context length`）⇒ 整页 textContent 自指命中，误报「已达长度上限」并掐掉一整轮
  //   （2026-10-10 12:02 实测；复现脚本 .ai-runner/tmp/limit-fp-repro.cjs：剥壳后 1 → 0）。
  // [CONSTRAINT] 实现体与 packages/core/src/headless/headless-inject.ts、headless-inject-simple.ts
  //   两处逐字符同构（守卫测试 limit-marker-guard 的 body-text parity 用例）。
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
  // 两类探针共用一个剥壳快照：先用整页 raw 做失效判据（字符串比较，零额外节点分配），
  // 仅在 raw 变化时剥壳一次 ⇒ 页面文本未变时零 clone（classifyAndPost 每 350ms 一跑，故必须共享）。
  let _scanRaw = null
  let _scanText = ''
  function scanBodyText() {
    const t = (document.body && document.body.textContent) || ''
    if (t === _scanRaw) return _scanText
    _scanRaw = t
    _scanText = bodyText()
    return _scanText
  }
  // [stopped-btn-v1] 全文关键词 stopped 探针（countStopMarkers / syncStopMarkerBaseline /
  //   stopMarkerBaseline / stopMarkerText）已于 2026-10-16 整体删除，勿复活：
  //   AI 讨论探针本身时会在正文里复述「已停止回答」等词 ⇒ 计数增长 ⇒ 误推 kind:'stopped'
  //   ⇒ 前端 stopped-window 闸门把 10s 内到达的真实脚本全部拦下（2026-10-15 实测）。
  //   现行判据见 classifyAndPost 内 [stopped-btn-v1] 段（按钮状态 + roots 冻结），
  //   守卫测试 packages/core/tests/stopped-btn-guard.node-test.ts 断言这些符号不得回潮。
  // [limit-detect-v3] 会话长度上限基线：与 headless 侧 detectReplyInPage 正则严格同构（改一处必须三处同步）。
  // 正则须覆盖「达到对话长度上限」（动词在前，DeepSeek 实际文案）与「对话长度已达上限」（名词在前）两种语序；
  // v3 起要求「上限」后必须自带动作子句（[，,：:]请? 或 请 + 开启/新建…新对话）：
  // 本函数扫的是**剥壳后的正文**（见上 [limit-scan-strip-v1]），正文自指「会话长度达到上限」与侧栏
  // 常驻按钮「开启新对话」的拼接都会造成假命中（2026-10-07 实测：页面无 banner 却弹 toast）。
  // [limit-en-branch-v1] 英文分支收紧（2026-10-10）：`maximum context length` 原先裸匹配，而 dump 进
  //   会话的源码行里就有探针自己的词表 ⇒ 自指命中。改为必须邻近 token 数（`(?:is|of)\s*\d+` 或
  //   后随 `\d+\s*tokens`）；`context length (?:limit|exceeded|too long)` 保持原样（带 `(?:` 前缀无法自匹配）。
  let limitMarkerBaseline = 0
  let limitMarkerText = ''
  let assistantRootBaseline = 0
  function countLimitMarkers() {
    try {
      const m = scanBodyText().match(/(?:(?:达到|已达|超出|超过)\s*(?:对话|会话|上下文)(?:长度)?\s*(?:上限|最大长度|超限|过长)|(?:对话|会话|上下文)(?:长度)?\s*(?:已达|已达到|达到|超出|超过)\s*(?:上限|最大长度|超限|过长)|(?:对话|会话|上下文)(?:长度)?超限|(?:对话|会话|上下文)(?:长度)?\s*(?:上限|最大长度|过长))(?:[，,：:]\s*请?|请)(?:开启|开始|新建|创建)(?:一个)?新(?:对话|会话)|context length (?:limit|exceeded|too long)|maximum context length (?:is|of)\s*\d+|maximum context length\s+\d+\s*tokens/gi) || []
      if (m.length) limitMarkerText = m[m.length - 1]
      return m.length
    } catch { return 0 }
  }
  // [limit-detect-v2] 本轮是否新增 AI 回复块：存量触顶兜底用（有触顶标记 + 无新块 = 会话早已触顶）
  function countAssistantRoots() {
    try {
      for (let i = 0; i < ASSISTANT_ROOT_SELECTORS.length; i++) {
        const els = document.querySelectorAll(ASSISTANT_ROOT_SELECTORS[i])
        if (els.length > 0) return els.length
      }
    } catch { /* swallow: 选择器不支持/文档未就绪，退化为 0 不启用兜底 */ }
    return 0
  }
  function syncLimitMarkerBaseline() {
    limitMarkerBaseline = countLimitMarkers()
    assistantRootBaseline = countAssistantRoots()
  }
  // [stopped-btn-v2] 最后一个 assistant 根的身份指纹（文本长度 + 首 64 字符）。
  // [WHY] roots 冻结判据单看计数分不清三种「计数不变」：① 本轮没产出任何回复块（真停止）；
  //   ② regenerate 原地替换（旧根删、新根添）；③ 虚拟列表回收旧根的同时挂上新根（DeepSeek
  //   实测计数会 3→1→2 抖动）。②③ 的最后根身份必然变化，只有①原样不动——身份补上后
  //   「冻结」才等价于「没产出」（2026-10-16 复检：regenerate 完成会误推 stopped）。
  function assistantRootId() {
    try {
      const r = latestAssistantRoot()
      if (!r) return ''
      const t = String(r.textContent || '')
      return `${t.length}:${t.slice(0, 64)}`
    } catch { /* swallow: 取身份失败按空串处理（与 enterRootId='' 相等时不启用身份判据） */ return '' }
  }
  // [stopped-btn-v2] roots 冻结判据：进入 generating 时的 roots 计数与最后根身份均未变。
  // [CONSTRAINT] enterCount>0 门槛保留：首轮无根时不予判定（无根站点的思考期停止不可判，
  //   同 [KNOWN-LIMIT-1] 的挂载时序依赖）。
  // [CHANGE-IMPACT] 判据收紧只会让 stopped 更少推（更保守），不会新增误推；
  //   真停止（思考阶段被停）形态不变：最后根停在进入时的旧回复上。
  function rootsFrozenNow(enterCount, enterRootId, nowCount, nowRootId) {
    return enterCount > 0 && nowCount === enterCount && nowRootId === enterRootId
  }

  function langFromText(s) {
    const t = String(s || '').trim().toLowerCase()
    if (!t || t.length > 24) return null
    if (/^(?:bash|sh|shell|zsh)\b/.test(t)) return 'bash'
    if (/^(?:js|javascript|cjs|commonjs|node|nodejs)\b/.test(t)) return 'js'
    return null
  }
  // [code-text-clean-v1] 从 <code class="language-xxx"> 直接判语言
  // [WHY] DeepSeek 代码块头的语言标签/复制按钮不进入 <code> 元素，取 className 比邻近 DOM 探测更可靠
  // [CONSTRAINT] 只认 js/bash 两种（与 extractLatestScript 白名单一致），其余返回 null 交给后续探测
  // [CHANGE-IMPACT] 与 guessLangFromDom / guessLangFromContent 组成三级回退，改单级不影响其他级
  function guessLangFromClass(el) {
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
    // [js-content-broaden-v1] 补常见 Node/fs/语法特征
    // WHY: 千问输出的脚本常直接 `fs.readdirSync(...)` / `const x = ...`，无 require/module.exports → 三级判定全 null → 整块被跳过降级为 plain 文本（用户反馈"脚本当成文本传了过来"）
    // CONSTRAINT: 只加高置信特征（fs. 调用 / const|let 赋值 / console.log / => 箭头 / JSON.parse）；避免误伤普通 Markdown 代码块（如纯 JSON 配置）
    // CHANGE-IMPACT: 特征命中即判 js；与 headless-inject.ts 的同名函数必须同步
    if (/\bfs\.(?:readFileSync|writeFileSync|readdirSync|existsSync|statSync|mkdirSync|unlinkSync)\b/.test(head)) return 'js'
    if (/\bconsole\.log\s*\(/.test(head)) return 'js'
    if (/\bJSON\.(?:parse|stringify)\s*\(/.test(head)) return 'js'
    if (/^(?:const|let)\s+\w+\s*=/.test(head)) return 'js'
    if (/^(?:echo|cd\s|ls\s|mkdir|git\s|pnpm\s|npm\s|yarn\s|rm\s)/m.test(head)) return 'bash'
    if (/\bif\s+\[\s/.test(head) || /\bfi\b/.test(head) || /\$\(/.test(head)) return 'bash'
    return null
  }
  // [strip-line-numbers-v1] 剔除语法高亮行号 span（react-syntax-highlighter 等）
  // WHY: 千问代码块每行前有 <span class="linenumber ...">N</span>，textContent 把行号粘进代码 →
  //   "#! /usr/bin/env node" 变成 "1#! /usr/bin/env node" → shebang/^const 正则全失配 → 脚本降级成 plain
  // CONSTRAINT: 克隆节点再删，不动真实 DOM；选择器覆盖 .linenumber 与 react-syntax-highlighter-line-number
  // CHANGE-IMPACT: extractLatestScript 的 text 不再含行号；hash 与执行内容均为纯净代码
  function codeTextOf(codeEl) {
    const clone = codeEl.cloneNode(true)
    clone.querySelectorAll('.linenumber, .react-syntax-highlighter-line-number, [class*="line-number"]').forEach(n => n.remove())
    return (clone.textContent || '').replace(/^\n+|\n+$/g, '')
  }

  function extractLatestScript() {
    // [script-closure-gate-v1] 结构闭合门 —— 未闭合的块**不当作完整脚本推送**。
    // [WHY] 在此之前，「不把流式半截块推出去」的唯一屏障是调用方的稳定判据
    //   （内置通道 = 「连续 2 帧同 hash」即 800ms 无变化；油猴通道 = 350ms 防抖 + 生成中门）。
    //   两者都只要求「这段时间内文本没变」，**都不要求块本身闭合**，于是：
    //   · 流式中途任何一次超过该窗口的停顿（网络抖动 / 站点渲染卡顿 / 模型思考）都会让半截块被判为完整；
    //   · 油猴通道另有一处：站点把回复切成「已停止」后「停止生成」按钮消失 ⇒ isGenerating() 转 false，
    //     而代码块并未闭合，半截块被当作完整脚本 post 出去。
    //   两者都让 /run 报 `Unexpected end of input` + 结构未闭合 ⇒ 与上游 max_tokens 截断的报错**完全同形**，
    //   应用端只能读成「脚本被截断」，于是反复拆小重发、白烧轮次。
    //   （[multi-script-v1] 记的是接收侧「只取最后一块」那一种成因；本条是接收侧的第三种。）
    // [CONSTRAINT] **只延迟、不丢弃**：正文长度连续 CLOSURE_ACCEPT_TICKS 次不变仍未闭合 ⇒
    //   判定为「上游真截断」，照旧放行（下游 400 会给「拆小重发」提示，补救路径不变）。
    //   故对正常脚本零影响（闭合块直接跳过本段）；含正则字面量等扫描器识别不了的形态最多延迟 ~2.4s。
    // [CONSTRAINT] 门状态挂在 window 上（不用 dedup）⇒ 内置通道与油猴通道本段**逐字同构**；
    //   本函数经 page.evaluate 序列化执行，禁止引用外部闭包变量。
    // [CONSTRAINT] 扫描器语义必须与 packages/core/src/post-run/script-check.ts 的 hasUnclosedStructure
    //   一致（那边是服务端判据），由 script-closure-gate 用例做语料对拍
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
    //   与 headless-inject.ts 的同名函数逐字同构，改一处必须同步另一处。
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
      return gate.ticks < 3
    }
    // [no-root-no-reply-v1] 只扫「最后一条 assistant 消息」容器内的 <pre>；容器不存在
    //   （新会话首轮「已思考/搜索」阶段）不得退回整页 —— 否则用户首条消息（如 SYSTEM.md 卡）
    //   里的代码块会被当脚本候选（2026-10-08 截图噪音同根因）。
    //   [CONSTRAINT] 与 headless-inject.ts 的 extractLatestScript 语义同构（那边直接查
    //   .ds-assistant-message-main-content，这边复用站点无关的 latestAssistantRoot）；
    //   两处由 script-closure-gate / multi-script-blocks 用假 DOM 对拍锁死。
    //   [parity-test] 假 DOM 同时实现 document 直查 pre 与容器查 pre 两条路径，本改动后
    //   依赖 latestAssistantRoot，由两个测试文件的 buildPicker deps 注入。
    const _scriptRoot = latestAssistantRoot()
    const pres = _scriptRoot ? _scriptRoot.querySelectorAll('pre') : []
    // [multi-script-v1] 一条回复可携带多个脚本：本函数只放行**首个尚未推送**的合格块，
    //   调用方推送后清空并再跑一次分类，逐块送出（前端串行执行）。
    // [WHY] 旧实现 `lastMarked || last` 只取最后一块，前面的块被静默丢弃；
    //   而最后一块恰恰是上游截断最可能切中的那一块 → 整轮白跑。
    // [CONSTRAINT] 与 headless-inject.ts 的 extractLatestScript 同义（那边用 dedup.seenHashes 数组，
    //   这边用闭包内的 seenHashes Set，故去重写法不同）；两处不得只改一处。
    let firstUnseen = null
    let firstUnseenMarked = null
    // [fragment-guard-v1] 同 headless-inject.ts：本回复内存在任意标记块时，无标记块视为片段不推。
    let hasAnyMarked = false
    for (const pre of pres) {
      // [code-text-clean-v1] 优先从 <pre><code> 取文本，避开代码块头的语言标签与「复制/下载」按钮文字
      // [WHY] pre.textContent 会把头部按钮文字并入首行，污染后 #! 锚点失配、语言判定失败导致整块跳过
      // [CONSTRAINT] 无 code 子元素时回退 pre 本身；去首尾空行逻辑保持原样
      const codeEl = pre.querySelector('code') || pre
      const text = codeTextOf(codeEl)
      if (!text) continue
      if (!text.includes('\n') && text.length < 120) continue
      // [code-text-clean-v1] 语言判定三级回退：className → DOM 邻近探测 → 内容特征
      let lang = guessLangFromClass(codeEl) || guessLangFromDom(pre) || guessLangFromContent(text) || null
      // [script-head-contract-fallback-v1] 脚本头契约：与 headless-inject.ts 该段保持严格同构
      // [WHY] 同款漏识别：AI 用非白名单语言标签（javascript/node/无标签）时三级判定得 null → 代码块被跳过 →
      //   前端只收到 plain 走 Markdown 渲染不执行（表现为「渲染了但没跑」）
      // [CONSTRAINT] 只认脚本头契约允许的两种形式（shebang / @desc）；本段与 headless-inject.ts 必须同改，避免双通道分叉
      // [CHANGE-IMPACT] 影响 classifyAndPost 的 kind 分流（line 429 kind:'script'）
      const _marked = /^#!\s*\/usr\/bin\/env\s+(?:node|bash)\b/m.test(text)
        || /^\s*\/\/\s*@desc\b/m.test(text)
        || /^\s*#\s*@desc\b/m.test(text)
      if (!lang && _marked) lang = 'js'
      // [script-lang-whitelist-v2] 语言白名单收紧为 js / bash，并**取消**「首行声明 SCRIPT 即无条件放行」。
      // [WHY] 旧判据在白名单之外还挂了一个 declared 豁免开关：声明 SCRIPT 时连语言判不出来的块
      //   （```python / ```json / 无标签）也收，前端把 null 折算成 'js' 当 cjs 交给 node → 必然语法错。
      //   脚本头契约（shebang / @desc）已由上方 _marked 兜底成 js，故删除该豁免不损失合法脚本。
      // [CONSTRAINT] 与 packages/core/src/headless/headless-inject.ts 的 extractLatestScript 逐字同构
      if (lang !== 'js' && lang !== 'bash') continue
      // [script-content-gate-v1] 非注释内容非空门：只有头部注释的残缺块不算完整脚本
      // [WHY] 22:18:14 实测：AI 流式中途只吐出 #! + @desc + @why + @plan 的头部，
      //   括号闭合门对纯注释天然为 false ⇒ 被判「完整」推送 → 前端跑一次空脚本，
      //   完整块到达后再跑一次 → 用户看到同 desc 执行两次（间隔 1.8s）。
      if (!hasExecutableContent(text)) continue
      // [script-closure-gate-v1] 未闭合 ⇒ 极可能仍在流式生成中途（或站点把回复切断了）：
      //   继续等下一帧；只有「正文长度连续 N 次不变」才判定为上游真截断并放行（约束见函数头）
      if (hasUnclosedStructureJs(text)) {
        if (stillStreamingReply()) continue
      }
      const item = { lang, code: text, hash: hash32(text) }
      // [fragment-guard-v1] marked 须在 seen 跳过**之前**计算：
      //   已推送过的标记块也要计入 hasAnyMarked（否则第二次 pick 会误判「本回复无标记块」而兜底推片段）。
      const marked = /^#!\s*\/usr\/bin\/env\s+(?:node|bash)\b/m.test(text)
        || /^\s*\/\/\s*@desc\b/m.test(text)
        || /^\s*#\s*@desc\b/m.test(text)
      if (marked) hasAnyMarked = true
      // [multi-script-v1] 已推送过的块不再参与选取，否则「首个未见」会永远卡在同一块上
      if (seenHashes.has(item.hash)) continue
      if (!firstUnseen) firstUnseen = item
      if (marked && !firstUnseenMarked) firstUnseenMarked = item
    }
    if (firstUnseenMarked) return firstUnseenMarked
    if (hasAnyMarked) return null
    return firstUnseen
  }

  // [multi-script-v1] 是否还有「尚未推送」的合格块；决定推送后要不要再跑一次分类
  // [WHY] 本通道靠 MutationObserver 触发，推完第一块后若 DOM 不再变动就再也不会被唤醒 →
  //   同一回复里的第 2、3 个脚本会一直躺着不发
  function hasMoreUnseenBlocks() {
    try {
      const s = extractLatestScript()
      return Boolean(s && !seenHashes.has(s.hash))
    } catch { return false }
  }

  // [md-fence-fallback-v1] DOM <pre> 提取失败时，从 Markdown 文本提取 ``` 围栏代码块
  // WHY: 千问等站点代码块不用标准 <pre><code> 结构，extractLatestScript 找不到 → 降级成 plain 文本
  // CONSTRAINT: 只从「最后一条 AI 回复」的 Markdown 里提取；语言标签白名单 js/bash/cjs/shell/sh/node
  // CHANGE-IMPACT: 与 extractLatestScript 互补，先 DOM 后 Markdown，不重复发送（hash 去重）
  function extractScriptFromMarkdown() {
    try {
      // [no-root-no-reply-v1] 容器缺失 ⇒ 无 Markdown 可提，整页反推会把侧栏/用户消息扫进来
      const root = latestAssistantRoot()
      if (!root) return null
      const md = extractReplyMd(root)
      // 匹配 ```lang\n...``` 或 ```\n...```（无语言标签）
      const fenceRe = /```(\w*)\n([\s\S]*?)```/g
      let m
      let last = null
      while ((m = fenceRe.exec(md)) !== null) {
        const rawLang = (m[1] || '').toLowerCase()
        const code = m[2].replace(/^\n+|\n+$/g, '')
        if (!code || (!code.includes('\n') && code.length < 120)) continue
        let lang = rawLang === 'javascript' || rawLang === 'node'
          ? 'js'
          : rawLang === 'sh' || rawLang === 'shell'
            ? 'bash'
            : rawLang === 'cjs'
              ? 'cjs'
              : rawLang === 'js'
                ? 'js'
                : rawLang === 'bash'
                  ? 'bash'
                  : null
        if (!lang) lang = guessLangFromContent(code)
        if (lang !== 'cjs' && lang !== 'js' && lang !== 'bash') continue
        last = { lang, code, hash: hash32(code) }
      }
      return last
    } catch { return null }
  }

  // [fix-undef] 从页面取最新一条回复的纯文本（排除 pre 代码块，用于 handoff 总结判定）
  function extractLatestReplyText() {
    // [ask-full-text-v1] 返回最后一条 assistant 容器的完整 Markdown（含段落换行）
    // [WHY] 原实现只取全局最后一个叶子节点 → 多段回复被截成末段，标记行前缀丢失
    // [CONSTRAINT] 复用 extractReplyMd（DOM→Markdown 反推）；容器缺失时回退 document
    try {
      // [no-root-no-reply-v1] 容器缺失返回空串，不再整页反推：
      //   新会话首轮「已思考/搜索」阶段无 assistant 容器，整页 elToMd 会把侧栏历史会话标题
      //   （未知标签递归 inner() 拼成连体乱文）+ 用户首条消息卡（SYSTEM.md）拼成「回复」
      //   （2026-10-08 18:53 截图两张噪音卡的正文形态）。
      const _root = latestAssistantRoot()
      if (!_root) return ''
      return extractReplyMd(_root)
    } catch { return '' }
  }

  // [done-comments] 从代码块中提取「DONE 起始的连续注释块」
  // 返回：{ raw: string[], tagged: { [tag]: string }, text: string, firstLine: string }

  // [done-md-reconstruct-v1] DOM → Markdown 反推：允许 AI 输出纯 Markdown 总结，
  // 但 textContent 会把 <h3>/<p>/<ul> 粘成一行；需按标签结构重建 Markdown 源码
  // [CONSTRAINT] 只覆盖 DeepSeek 常用标签；未知标签递归取子节点文本（兜底）
  // [CHANGE-IMPACT] 输出直接喂给前端 renderMarkdown；改这里必须同步 headless-inject 的 elToMd
  function elToMd(node) {
    if (!node) return ''
    if (node.nodeType === 3) return node.textContent || ''
    if (node.nodeType !== 1) return ''
    const el = node
    const tag = el.tagName.toLowerCase()
    const inner = () => Array.from(el.childNodes).map(c => elToMd(c)).join('')
    if (tag === 'br') return '\n'
    if (tag === 'hr') return '\n---\n\n'
    if (/^h[1-6]$/.test(tag)) return `${'#'.repeat(Number(tag.charAt(1)))} ${inner().trim()}\n\n`
    if (tag === 'p') return `${inner().trim()}\n\n`
    if (tag === 'ul' || tag === 'ol') {
      const out = []
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
      // [strip-line-numbers-v1] 用 codeTextOf 剔除行号，与 extractLatestScript 保持一致
      const src = codeTextOf(code || el)
      return `\`\`\`${m ? m[1] : ''}\n${src}\n\`\`\`\n\n`
    }
    if (tag === 'code') return `\`${el.textContent || ''}\``
    if (tag === 'blockquote') return `${inner().split('\n').map(l => `> ${l}`).join('\n')}\n\n`
    if (tag === 'table') {
      const rows = []
      for (const tr of Array.from(el.querySelectorAll('tr'))) {
        rows.push(`| ${Array.from(tr.children).map(c => elToMd(c).trim()).join(' | ')} |`)
      }
      return `${rows.join('\n')}\n\n`
    }
    return inner()
  }

  function extractReplyMd(root) {
    if (!root) return ''
    const node = root.nodeType === 9 ? root.body : root
    if (!node) return ''
    return elToMd(node).replace(/\n{3,}/g, '\n\n').trim()
  }

  // [reply-mark-v1] 统一回复标记识别：`SCRIPT` / `ASK` / `DONE` / `HANDOFF` / `TEXT` 共用「首行标记行」判据
  // [WHY] 原「首行严格 DONE」与本通道 / headless-inject / 前端 parseAsk 的形态不一致 →
  //   同一条回复在不同链路被分到不同类别，甚至整轮丢失。统一为「首个非空行 = 独占标记行」。
  // [CONSTRAINT] 内部不得出现 TS 类型注解；与 headless-inject.ts、packages/client/utils/reply-mark.ts
  //   逐句同构，由 reply-mark-parity 守卫测试三处对拍锁死。改一处必须同步三处。
  function scanReplyMarks(md) {
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

  function findNewDone() {
    // [no-root-no-reply-v1] 容器缺失 ⇒ 无 DONE 可言；整页反推会把用户首条消息（含 SYSTEM.md 卡）扫进来
    const _root = latestAssistantRoot()
    if (!_root) return null
    // [done-md-reconstruct-v1] 用 DOM→Markdown 反推替代 textContent（保留换行与结构）
    const summary = extractReplyMd(_root)

    // [reply-mark-v1] 判据走统一标记扫描：只认首个非空行的独占标记行
    //   （正文写「DONE 之后…」不会命中；首行不是标记就不是 done）
    // [CHANGE-IMPACT] 与 headless-inject 的 kind 分流同名同义，改一处必须同步三处
    if (summary && scanReplyMarks(summary).done > 0) {
      // [done-marker-no-len-v1] 同无头：去掉 summary.length，防流式每帧变新 marker 重复推 DONE
      const headMarker = hash32(`done-head|${summary.slice(0, 200)}`)
      if (!seenDoneMarkers.has(headMarker)) {
        return { marker: headMarker, text: summary }
      }
    }

    return null
  }

  function bodySignature() {
    // [assistant-root-v1] 优先用「最后一条 AI 回复」容器的文本做签名
    // WHY: 整页末 300 字符在千问这类站点是输入框/页脚，AI 流式期间恒定 → 无法触发回传
    // CONSTRAINT: 容器存在且文本非空才用其签名；否则退回整页末 300 字符（旧行为，保证其他站点不回归）
    const root = latestAssistantRoot()
    const rootText = root ? (root.textContent || '').replace(/\s+/g, ' ').trim() : ''
    const t = rootText || (document.body.textContent || '').replace(/\s+/g, ' ')
    return hash32(t.slice(-300))
  }

  // [debounce-flatten-v1] 单级 350ms 节流：原 replyObserver 与 classifyAndPost 共用 replyDebounce，
  //   每次 DOM 变化都重设 2000ms；AI 流式期间 DOM 持续抖动 → 核心逻辑永远被推迟到"最后一次变化后再 2s"才执行。
  // [CONSTRAINT] 350ms 是合并流式抖动的下限；lastBodySig / seenHashes / seenDoneMarkers 已保证同内容不重复 post。
  // [CHANGE-IMPACT] 弹窗感知延迟 ~2s → ~0.35s；classifyAndPost 改为同步执行，节流由 observerDebounce 单点承担。
  // [generating-gate-v1] 生成中不发送 script/plain
  // WHY: 千问等站点流式输出（打字机），350ms 防抖间隙内脚本只出了一半；partial 的 hash 每次都变 → seenHashes 失效，连发多条残缺脚本
  // CONSTRAINT: 以「停止生成」按钮可见且可用为"仍在生成"信号；生成结束后按钮消失 → DOM 变化再触发 classifyAndPost，此时取到完整内容
  // CHANGE-IMPACT: script/plain 延迟到生成结束；DONE 整行匹配不受影响（流式中不会误出 DONE 首行）
  // [stop-btn-widen-v1] 与 findSendButton 同构：把查询范围从 'button' 扩到
  //   'button, div[role="button"]'，并纳入 data-testid。原实现只查 button，
  //   若站点把「停止生成」渲染成 div[role=button] 则必然 miss ⇒ clickStopGenerating
  //   的 Esc 兜底又未必被站点响应 ⇒ 用户实测「AI 端暂停没起作用」。
  // [stop-btn-widen-v2] 无真实 DOM 时的最宽匹配：
  //   范围扩到 button / div|span|a[role] / [role=switch|menuitem]（站点渲染成哪种都覆盖）；
  //   属性加 class / data-state；正则补 cancel|abort|interrupt|halt|终止|取消|暂停。
  //   误伤风险：class 含 stop 的普通容器可能被选中——故保留「必须可点击（非 disabled）」这一层。
  const STOP_LABEL_RE = /停止生成|停止回答|停止输出|终止|取消生成|停止|中断|暂停生成|stop\s*generat|stop\s*stream|stop\s*response|stop\s*answer|stop\s*cancel|\bcancel\b|\babort\b|\binterrupt\b|\bhalt\b/i
  // [stop-btn-scope-v1] collectStopCandidates 只搜「输入区」：页面上任何瞬态可点击元素，只要
  //   文本/属性命中 STOP_LABEL_RE（上传 Cancel、对话框「取消生成」…），都会让 isGenerating()
  //   假 true；其消失又伪造「按钮从有到无」+ roots 冻结 ⇒ 误推 kind:'stopped' 杀整个循环
  //   （2026-10-16 复检实测：空闲页一个 <button>Cancel</button> 即可走通整条链）。
  //   各站点的停止/发送按钮都位于输入区（与 findStopGeneratingBtnStructural 同 scope），
  //   取不到输入框时退回 document（无输入框页面行为不变）。
  // [RESIDUAL-RISK] 输入区**内部**的瞬态停止词元素（如附件预览里的 Cancel）仍会命中——
  //   范围收敛把面从「整页」缩到「输入区」，未清零；DeepSeek 已由图签名兜底另辟通道
  //   （[stop-btn-deepseek-icon-v1]），其余站点真清零仍需各自的发送/停止态可区分特征。
  function collectStopCandidates() {
    const sel = 'button, div[role], span[role], a[role], [role="switch"], [role="menuitem"]'
    // scope 从 parentElement 起找（不用 input.closest：输入框自身 class 含 input 时会命中自己，
    //   而 textarea 无子节点 ⇒ 停止按钮永远找不到 ⇒ generating gate 失效）
    let scope = document
    const box = findInputBox()
    const pe = box ? box.parentElement : null
    if (pe) {
      scope = pe.closest('form, [class*="input"], [class*="composer"], [class*="chat-input"], [class*="input-area"], [class*="input-box"], [class*="input_wrap"], [class*="chat-foot"], [class*="dialog-footer"]') || pe
    }
    const out = []
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
      if (STOP_LABEL_RE.test(lbl)) out.push(el)
    }
    return out
  }
  // [stop-btn-deepseek-fallback-v1] DeepSeek 的「停止/发送」按钮实测无 aria-label/title/data-testid/textContent，
  //   仅 <div role="button" class="ds-button ds-button--primary ds-button--filled ds-button--circle ..."> 可识别。
  //   STOP_LABEL_RE 的文本匹配对它恒 miss ⇒ 必须补结构化兜底。
  //   [WHY] 发送态与停止态共用同一元素，故仅凭「圆形按钮存在」**不能**判生成中（发送态恒真会把
  //   generating gate 钉死）；区分两态要靠图标，见 [stop-btn-deepseek-icon-v1]。
  //   [CHANGE-IMPACT] 仅当标签匹配全 miss 时启用；对千问等已有 aria-label 的站点零影响。
  function findStopGeneratingBtnStructural() {
    const input = findInputBox()
    if (!input) return null
    let root = input.closest('form')
    if (!root) {
      let p = input.parentElement
      for (let i = 0; i < 8 && p; i++) {
        if (p.querySelector('[role="button"].ds-button--circle, button.ds-button--circle')) { root = p; break }
        p = p.parentElement
      }
    }
    const scope = root || document
    const cand = scope.querySelectorAll('[role="button"].ds-button--circle, button.ds-button--circle')
    for (const el of cand) {
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue
      return el
    }
    return null
  }
  // [stop-btn-deepseek-icon-v1] DeepSeek 发送/停止同元素且无标签（[stop-btn-deepseek-fallback-v1]），
  //   但两态图标不同（bundle 实证：chat.deepseek.com main.a0ce88b684.js，commit-id fd5d6ec3）：
  //   停止态 = 圆角方块（16x16，单 path，d 以 "M2 4.88C2 3.68009" 开头、含 "V11.12C14 12.3199"），
  //   发送态 = 上箭头（d 以 "M8.3125 0.980206" 开头）。
  //   判据：圆形按钮内 svg path 的 d 命中停止方块签名 ⇒ 生成中。
  // [WHY] 不用「按钮存在」直接判：发送态同元素也存在 ⇒ 恒真会让 generating gate 永不释放、脚本全卡死。
  // [FAIL-OPEN] 锚点是坐标字面量，DeepSeek 改版图标后本分支静默失效（退回修复前行为：该站点
  //   isGenerating() 恒 false），**不会**误判生成中；锚点由 stopped-btn-guard.node-test.ts 假 DOM 钉住。
  const DS_STOP_ICON_ANCHORS = ['M2 4.88C2 3.68009', 'V11.12C14 12.3199']
  function hasDeepSeekStopIcon(btn) {
    try {
      const paths = btn.querySelectorAll('svg path')
      for (let i = 0; i < paths.length; i++) {
        const d = paths[i].getAttribute('d') || ''
        if (DS_STOP_ICON_ANCHORS.some(a => d.includes(a))) return true
      }
    } catch { /* 假 DOM / 站点结构异常：按非停止态处理（fail-open） */ }
    return false
  }
  function findStopGeneratingBtn() {
    return collectStopCandidates()[0] || null
  }
  function isGenerating() {
    const btn = findStopGeneratingBtn()
    if (btn && !btn.disabled) return true
    // [stop-btn-deepseek-icon-v1] DeepSeek 圆形按钮无标签 ⇒ 标签匹配恒 miss，用停止方块图签名名兜底
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

  const replyObserver = new MutationObserver(() => {
    if (observerDebounce) clearTimeout(observerDebounce)
    observerDebounce = setTimeout(() => {
      observerDebounce = null
      classifyAndPost()
    }, 350)
  })

  // [stop-v2] 监听生命周期标志 + 重挂入口
  // [WHY] stop 需 disconnect 防止旧回复重放；下次 fill/rotate 前须能恢复监听
  // [CONSTRAINT] 声明顺序固定在 replyObserver 之后，避免 no-use-before-define
  // [CHANGE-IMPACT] 被 stop / fill / rotate 三个分支引用，改此处必须同步改三个触发点
  let _replyObserving = false
  function resumeReplyObserver() {
    if (_replyObserving) return
    try {
      // [wake-attrs-v1] 追加 attributes 监听：使「停止生成」按钮的态变（class/disabled/aria-label/data-state）
      //   也能唤醒 classifyAndPost，作为「生成结束」的兜底唤醒源（与 [generating-gate-v2] 互补）。
      //   [WHY] 仅 childList/characterData 时，按钮消失/置灰这类纯属性变更无法触发 observer，
      //   若又逢 DOM 静止就只剩用户滚动才能唤醒（2026-10-09 实测：回传延迟 54~65s，滚动后秒推）。
      // [wake-attrs-v2] 给 observer 加 attributes 监听，让「停止生成」按钮的态变也能唤醒回传。
      //   attributeFilter 刻意不含 'class'：流式渲染/光标动画下 class 变更极高频，会制造 observer
      //   回调风暴；停止生成按钮的态变通常走 disabled / aria-label / data-state，这三个足够覆盖，
      //   且变更频次低，350ms 防抖 + 单飞即可挡住推送风暴（[generating-gate-v2] 单飞自检兜底）。
      replyObserver.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'aria-label', 'data-state'] })
      _replyObserving = true
    } catch { /* body 未就绪，下次 fill/rotate 再试 */ }
  }
  resumeReplyObserver()
  // [idle-wake-poll-v1] 空转唤醒兜底：MutationObserver 只在 DOM 变动时唤醒，
  //   回复渲染完成后（流式光标移除 / 高亮完成 / 操作条挂载）DOM 静止 ⇒ 若脚本块因任何原因
  //   尚未推送（闭合门延迟 / 生成中门 / 多块续推），observer 永不触发，块永久滞留
  //   （2026-10-11 用户实测：滚动一下页面即收到 → 滚动引发的 DOM 变动唤醒）。
  //   [WHY] headless 侧 startReplyPoll 是 800ms 轮询天然无此症；本补丁对齐该频率。
  //   [CONSTRAINT] 后台标签页（document.hidden）不跑；无 assistant 容器不跑；observer 防抖在途时不跑
  //     （避免与 350ms 防抖抢），三条件均不满足才调用 classifyAndPost。classifyAndPost 自身
  //     以 seenHashes + lastBodySig 幂等，即便误唤醒也不会重复推送。
  //   [CHANGE-IMPACT] 若去掉本段，油猴通道在 DOM 静止后完全依赖用户交互（滚动 / 点击）唤醒。
  setInterval(() => {
    try {
      if (typeof document !== 'undefined' && document.hidden) return
      if (observerDebounce) return
      if (!latestAssistantRoot()) return
      classifyAndPost()
    } catch { /* swallow: 页面导航/关闭时忽略 */ }
  }, 800)
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
