/* eslint-disable ts/ban-ts-comment -- 需禁用整文件类型检查 */
// @ts-nocheck

// 浏览器上下文 DOM 逻辑：这些函数通过 page.evaluate 序列化后传入浏览器执行。
// Node 侧 tsconfig 无 DOM lib，故此文件豁免类型检查（函数体运行环境有完整 DOM）。
// 从 scripts/tampermonkey-session-id.user.js 移植（findInputBox / fillInput / findSendButton / sendEnter / clickStopGenerating / clickNewSession）。
// 约束：纯函数、无外部闭包引用 —— 序列化后代码结构必须完整。

// [headless-inject-simple-wired-v1] 6 个短函数已抽到 headless-inject-simple.ts

export {
  clickNewSessionInPage,
  detectLoginStateInPage,
  fillPromptInPage,
  resetReplyDedupInPage,
  stopGeneratingInPage,
  verifyFillSentInPage,
} from './headless-inject-simple.js'

/**
 * 检测 Reply In Page
 */
export function detectReplyInPage() {
  const w = window
  if (!w.__aiRunnerDedup) {
    w.__aiRunnerDedup = { seenHashes: [], seenDoneMarkers: [], lastBodySig: '', _pendingScriptHash: null, _plainSentInCycle: false } // [fix-reply-dedup] [fix-plain-once]
  }
  const dedup = w.__aiRunnerDedup
  // body version + hash 缓存，避免每次 poll 重算
  if (typeof dedup._bodyVersion !== 'number') dedup._bodyVersion = 0
  if (!dedup._sigCache) dedup._sigCache = { version: -1, sig: '' }
  if (!dedup._preCache) dedup._preCache = new WeakMap()
  if (typeof dedup._seenGrowth !== 'boolean') dedup._seenGrowth = false
  if (typeof dedup._stableCount !== 'number') dedup._stableCount = 0
  // [script-closure-gate-v1] 结构闭合门的挂点（见 extractLatestScript）：跨轮不残留，
  //   依赖 stillStreamingReply 的「正文长度变化即重置」自愈，这里只保证键存在
  if (typeof w.__aiRunnerClosureGate === 'undefined') w.__aiRunnerClosureGate = null
  // [stopped-detect-v2] 冷启动基线 = 当前存量标记数。页面刷新（F5 / rotate / 新开）会清空
  //   __aiRunnerDedup，而 DeepSeek 的「已停止」角标会**永久留在历史消息下方**；旧逻辑冷启动
  //   基线硬编码 0 → 首次 poll 就把历史角标当成「本轮被停止」误报 {kind:'stopped'}，
  //   循环被判 ai-stopped 终止（表现为「探测一直已停止」，重进页面再犯）。与
  //   resetReplyDedupInPage 的 fill 时基线同一口径：基线只对「本轮新增」负责。
  // [stopped-detect-v2] 冷启动基线 = 当前存量标记数。页面刷新（F5 / rotate / 新开）会清空
  //   __aiRunnerDedup，而 DeepSeek 的「已停止」角标会**永久留在历史消息下方**；旧逻辑冷启动
  //   基线硬编码 0 → 首次 poll 就把历史角标当成「本轮被停止」误报 {kind:'stopped'}，
  //   循环被判 ai-stopped 终止（表现为「探测一直已停止」，重进页面再犯）。与
  //   resetReplyDedupInPage 的 fill 时基线同一口径：基线只对「本轮新增」负责。
  if (typeof dedup._stoppedBaseline !== 'number') {
    dedup._stoppedBaseline = (((document.body && document.body.textContent) || '').match(/当前问题已停止|已停止生成|已停止回答/g) || []).length
  }
  if (typeof dedup._limitBaseline !== 'number') dedup._limitBaseline = 0 // [limit-detect-v1]
  if (typeof dedup._rateBaseline !== 'number') dedup._rateBaseline = 0 // [rate-retry-v1]
  if (!dedup._observerInstalled) {
    dedup._observerInstalled = true
    try {
      const obs = new MutationObserver(() => { dedup._bodyVersion++ })
      obs.observe(document.body, { childList: true, subtree: true, characterData: true })
      dedup._observer = obs
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
  // [WHY] fill 点发送后旧回复仍挂在页尾（@ask 场景最后一条 assistant 消息就是旧问题），
  //       清空式 dedup 重置会让首轮 poll 把旧 @ask 当新回复重推 → 弹窗死循环，且挤掉真正的新回复
  // [CONSTRAINT] DeepSeek 每轮回复新增独立消息节点，blocks.length 增长即新回复到达；
  //              _baselineBlocks 仅由 resetReplyDedupInPage 写入，未 reset 时 undefined 不拦截
  const _baseBlocks = document.querySelectorAll('.ds-assistant-message-main-content')

  if (!dedup._busyErrorReported) {
    const bodyText = (document.body && document.body.textContent) || ''
    const busyMessages = bodyText.match(/server busy, please try again later\.?|(?:服务器|服务)繁忙[^\n。！!]*[。！!]?/gi) || []
    const busyBaseline = typeof dedup._busyErrorBaseline === 'number' ? dedup._busyErrorBaseline : 0
    if (busyMessages.length > busyBaseline) {
      dedup._busyErrorReported = true
      return { kind: 'error', text: busyMessages[busyMessages.length - 1] }
    }
  }

  // [rate-retry-v1] 频控感知：发送被站点「消息发送过于频繁」拒收时本轮不可能有回复，
  // 立即推 error 让前端 toast 告知原因（复用 busy 通道），而不是干等 90s/180s 超时。
  // [CONSTRAINT] 按出现次数 + 基线去重：历史消息里的旧频控文案不触发；本轮只推一次；
  //              正则与 headless-inject-simple.ts 的 verifyFillSentInPage / resetReplyDedupInPage 两处内联同构
  //              （守卫测试 rate-marker-guard.node-test.ts）
  if (!dedup._rateReported) {
    const rateText = (document.body && document.body.textContent) || ''
    const rateMessages = rateText.match(/(?:消息|发送|操作|请求|访问)过于频繁|过于频繁[，,\s]*请稍后重试|please\s+slow\s+down|too\s+many\s+requests|rate\s+limit/gi) || []
    const rateBaseline = typeof dedup._rateBaseline === 'number' ? dedup._rateBaseline : 0
    if (rateMessages.length > rateBaseline) {
      dedup._rateReported = true
      return { kind: 'error', text: rateMessages[rateMessages.length - 1] }
    }
  }

  // [stopped-detect-v1] 「当前问题已停止」感知：生成被中止（用户点停止 / 平台中断 / 内容策略截断）时，
  // 回复永远没有 DONE 也没有完整脚本，plain 分支又被 hasJsFence 门槛拦住 → 页面侧零推送，
  // 前端干等 90s/180s 超时（表现为「AI 网页已停止，工作台还在转圈」）。
  // [WHY] 独立于基线守卫：stop 标记可能出现在无新增 assistant 块的场景（生成刚开始就被停）
  // [CONSTRAINT] 按出现次数 + 基线去重：历史消息里的旧「已停止」标记不触发；本轮只推一次
  if (!dedup._stoppedReported) {
    const stopText = (document.body && document.body.textContent) || ''
    const stopMessages = stopText.match(/当前问题已停止|已停止生成|已停止回答/g) || []
    const stopBaseline = typeof dedup._stoppedBaseline === 'number' ? dedup._stoppedBaseline : 0
    if (stopMessages.length > stopBaseline) {
      dedup._stoppedReported = true
      return { kind: 'stopped', text: stopMessages[stopMessages.length - 1] }
    }
  }

  // [limit-detect-v2] 会话长度上限感知：触顶后继续在本会话提问不可能有产出，与「已停止」同构——
  // 无 DONE 无完整脚本、plain 被 hasJsFence 拦 → 前端无感知干等超时。
  // [WHY] DeepSeek 实际文案是「达到对话长度上限，请开启新对话」——动词在前的语序；
  //       v1 只写了「对话…已达上限」的名词在前形式 → 真实提示完全漏匹配（线上表现为仍在干等）。
  //       故补「动词+名词+上限」「名词+动词+上限」「名词+超限」三序，并要求末段「上限」后可接「请开启新对话」。
  // [CONSTRAINT] 基线去重仍保留：只在「计数增长」时推送，排除历史消息里的旧标记；
  //              末段分支要求紧跟「开启/新建新对话」，故侧栏常驻的「开启新对话」按钮不会被误计。
  // [CONSTRAINT] 正则须与 headless-inject-simple.ts 基线、油猴 countLimitMarkers 三处严格同构，改一处必同步
  if (!dedup._limitReported) {
    const limitText = (document.body && document.body.textContent) || ''
    const limitMessages = limitText.match(/(?:达到|已达|超出|超过)\s*(?:对话|会话|上下文)(?:长度)?\s*(?:上限|最大长度|超限|过长)|(?:对话|会话|上下文)(?:长度)?\s*(?:已达|已达到|达到|超出|超过)\s*(?:上限|最大长度|超限|过长)|(?:对话|会话|上下文)(?:长度)?超限|(?:对话|会话|上下文)(?:长度)?\s*(?:上限|最大长度|过长)[，,：:]?\s*请?(?:开启|开始|新建|创建)(?:一个)?新(?:对话|会话)|context length (?:limit|exceeded|too long)|maximum context length/gi) || []
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

  if (typeof dedup._baselineBlocks === 'number' && _baseBlocks.length > 0 && _baseBlocks.length <= dedup._baselineBlocks) return null

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
    const root = blocks.length > 0 ? blocks[blocks.length - 1] : document
    if (root.querySelectorAll('pre code, pre').length > 0) return true
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
  //   过渡别名：`@ask`（旧 SYSTEM.md 注入的会话）与 `# 任务`（旧 SUMMARY_INSTRUCTION）仍接受
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
    else if (/^(?:ASK|@ask)$/i.test(line)) out.ask = head + 1
    else if (/^DONE$/.test(line)) out.done = head + 1
    else if (/^(?:HANDOFF|#\s*任务)$/.test(line)) out.handoff = head + 1
    else if (/^TEXT$/.test(line)) out.text = head + 1
    return out
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
    // 只扫最后一条 assistant 消息，排除历史/用户消息
    const blocks = document.querySelectorAll('.ds-assistant-message-main-content')
    const root = blocks.length > 0 ? blocks[blocks.length - 1] : document
    const pres = root.querySelectorAll('pre')
    // [multi-script-v1] 一条回复允许携带多个脚本：本函数每帧只放行**一个**尚未推送的块，
    //   由调用方的「连续 2 帧同 hash」稳定判据逐块送出，前端再串行执行。
    // [WHY] 旧实现 `lastMarked || last` 只取最后一块，前面所有块被**静默丢弃**；
    //   而最后一块恰恰是上游截断最可能切中的那一块 → 一整轮白跑（用户实测的「脚本被截断」）。
    // [CONSTRAINT] 仍优先取「带脚本头契约标记」的块（shebang / @desc），避免把正文里的示例代码当脚本；
    //   无标记块只在没有任何未见过的标记块时才兜底。seenHashes 去重保证同一块不会重复放行。
    const seenHashes = dedup.seenHashes
    let firstUnseen = null
    let firstUnseenMarked = null
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
      // [multi-script-v1] 已推送过的块不再参与选取，否则「首个未见」会永远卡在同一块上
      if (seenHashes.includes(_h)) continue
      if (!firstUnseen) firstUnseen = item
      const marked = /^#!\s*\/usr\/bin\/env\s+(?:node|bash)\b/m.test(text)
        || /^\s*\/\/\s*@desc\b/m.test(text)
        || /^\s*#\s*@desc\b/m.test(text)
      if (marked && !firstUnseenMarked) firstUnseenMarked = item
    }
    return firstUnseenMarked || firstUnseen
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
    const root = blocks.length > 0 ? blocks[blocks.length - 1] : document
    const full = extractReplyMd(root)
    if (!full) return null
    if (scanReplyMarks(full).done < 0) return null
    const marker = hash32(`done-head|${full.slice(0, 200)}|${full.length}`)
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

  // [reply-mark-v1] 标记行优先：先算首行标记，再决定是否走 DOM 结构判定
  // [WHY] 带 `@ask` / `DONE` / `# 任务` 标记的回复若含代码块，旧逻辑会被 script 分支抢走
  //   （script 判定排在 done / plain 之前）→ `DONE` 总结里的示例代码块会被当脚本重新执行
  // [CONSTRAINT] extractReplyMd 是 DOM→Markdown 反推（保留换行），getMainText 的 textContent 无换行、
  //   无法用于「首行」判定，故标记扫描一律基于前者
  const replyBlocks = document.querySelectorAll('.ds-assistant-message-main-content')
  const replyRoot = replyBlocks.length > 0 ? replyBlocks[replyBlocks.length - 1] : document
  const marks = scanReplyMarks(extractReplyMd(replyRoot))
  const markedNonScript = marks.ask > 0 || marks.done > 0 || marks.handoff > 0 || marks.text > 0

  // script 需连续 2 次相同 hash 才推，避开流式中途残缺
  // [script-lang-whitelist-v2] 不再传 declared：语言白名单恒为 js/bash（见 extractLatestScript）
  const script = markedNonScript ? null : extractLatestScript()
  if (script && !dedup.seenHashes.includes(script.hash)) {
    if (dedup._pendingScriptHash === script.hash) {
      dedup._pendingScriptHash = null
      dedup.seenHashes.push(script.hash)
      dedup.lastBodySig = bodySignature()
      return { kind: 'script', code: script.code, lang: script.lang, hash: script.hash }
    }
    dedup._pendingScriptHash = script.hash
    return null
  }

  const doneMarker = findNewDone()
  if (doneMarker) {
    dedup.seenDoneMarkers.push(doneMarker.marker)
    dedup.lastBodySig = bodySignature()
    // [done-plain-v1] 不再要求 js 围栏：已允许纯 Markdown 总结
    return { kind: 'done', text: doneMarker.text }
  }

  // 文本稳定检测：连续 3 次 body 不变 → 生成结束，推 plain + text
  const sig2 = bodySignature()
  if (sig2 !== dedup.lastBodySig) {
    dedup.lastBodySig = sig2
    dedup._stableCount = 0
    dedup._seenGrowth = true
    return null
  }
  if (!dedup._seenGrowth) return null
  if (dedup._plainSentInCycle) return null
  dedup._stableCount = (dedup._stableCount || 0) + 1
  if (dedup._stableCount < 3) return null
  const plainText = getMainText()
  // [reply-mark-v1] 复用开头算好的 marks（同一份「首行标记行」判据，避免与脚本判定口径漂移）：
  //   轮转摘要放行（SUMMARY_INSTRUCTION 要求 AI 输出 `HANDOFF` 首行 + 结构化摘要，无代码块，
  //   不放行则 handoff 态永远收不到总结 → 30s 超时失败）；
  //   含 ASK 的回复放行（交互提问需用户响应）；
  //   [text-mark-v1] 含 TEXT 的回复放行（显式声明的纯文本回执）；
  //   其余纯文本仍被拦下（过滤纯问候语的原意保留）
  // [CONSTRAINT] 不能用 getMainText() 的 textContent 做标记扫描：它是 DOM textContent，
  //   无换行，整段被当成「一行」，首行标记判据必然失配；marks 来自 extractReplyMd（保留换行）
  if (!hasJsFence(plainText) && marks.ask < 0 && marks.handoff < 0 && marks.text < 0) return null
  dedup._plainSentInCycle = true
  // [text-mark-v1] TEXT 标记的载荷：取 DOM→Markdown 反推正文并剥掉标记行。
  // [WHY] getMainText() 是 textContent——块级标签之间不插换行，标记行会与正文粘成一行，
  //   前端 renderMarkdown 拿到的是「TEXTxxx」一整段，段落/列表全塌。
  if (marks.text > 0) {
    const body = extractReplyMd(replyRoot).split(/\r?\n/).slice(marks.text).join('\n').trim()
    return { kind: 'plain', text: body || plainText }
  }
  return { kind: 'plain', text: plainText }

  return null
}
