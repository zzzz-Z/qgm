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
