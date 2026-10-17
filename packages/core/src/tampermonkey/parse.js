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
const lastBodySig = ''
// [done-stable-gate-v1] DONE 分支的 2 帧稳定门（与 headless-inject.ts 同构）。
// [WHY] marker 是 hash(`done-head|${summary.slice(0,200)}`)；短内容时前 200 字随流式变化 ⇒
//   去重失效 ⇒ 同一 DONE 被推 N 次（2026-10-17 用户实测）。
const _pendingDoneSig = null
const _scriptFenceReported = false
// [stopped-btn-v1] stopped 分支的回传文案。[stopped-toast-quote-v1] 的「带命中原文」机制随
//   全文关键词探针一起废止（按钮驱动后没有正文命中可带；原文通道的自指风险见该 tag 历史：
//   停机态文案与 UI 文案同形，2026-10-10 14:14 实测页面一切正常却弹停止提示）。
// [CONSTRAINT] 兜底值必须**分段拼接**：整句字面量会成为探针源码的自命中。
const STOPPED_GENERIC = 'AI 网页' + '已停止' + '生成'
// [stopped-plain-noise-v1] 本轮是否已推过 stopped：置位后 plain 分支不再补发半截回复
// （与 headless-inject.ts 的 dedup._stoppedReported 同义；随 fill/rotate 轮次重置）
const stopPosted = false
// [stopped-btn-v1] 按钮状态驱动的停止检测（替代全文关键词 countStopMarkers）：
//   不再扫描「已停止生成/回答/输出」等文本关键词（AI 讨论探针本身时会在正文里自指命中
//   → 误推 stopped → 后续脚本被 stopped-window 闸门拦截）。
//   改为追踪「停止按钮」状态变化：
//   - prevGenerating：上一轮 classifyAndPost 看到的按钮状态（true=存在且可点）
//   - genEnterRoots：进入 generating 状态时的 assistant 根数量
//   - genEnterRootId：进入 generating 时最后一个 assistant 根的身份指纹（[stopped-btn-v2]）
//   判据：prevGenerating===true + 当前!isGenerating + roots 未增长且最后根身份未变 = 真中断
const prevGenerating = false
const genEnterRoots = 0
const genEnterRootId = '' // [stopped-btn-v2] 与 genEnterRoots 同时记录，见 rootsFrozenNow
// [limit-posted-v1] 本轮是否已推过 limit：**存量兜底通道（limitStale）每轮恒真**，
//   而「更新 limitMarkerBaseline」压不住它 —— 该通道不依赖计数增长，基线更新前后恒真
//   ⇒ 每轮 classifyAndPost 都会再 post 一次 kind:'limit'（2026-10-10 15:07 用户实测：
//   toast 队列被 MAX_VISIBLE=3 打满，稳态交替 [warn,info,warn] / [info,warn,info]）。
// （与 headless-inject.ts 的 dedup._limitReported 同义；随 fill/rotate 轮次重置）
// [WHY] headless 侧早有该旗标（:172 守卫 / :180 置位），油猴侧从未同步 ——
//   这是 2026-10-10 同一天内第三次撞上「headless 有、油猴没有」（前两次：回传命中原文、冷启动基线）。
// [CONSTRAINT] **只压「存量兜底」通道**；「计数增长」通道自限、不 gate ——
//   否则一次误报就把本轮后续的**真**触顶信号一起挡死。
const limitPosted = false
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
const _roundBaselinesReady = false
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
