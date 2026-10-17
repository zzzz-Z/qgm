// @ts-nocheck
// [tampermonkey-ts-rewrite-v1] IIFE 物理切分片段，非独立模块；跨片段符号在单文件检查下不可见。
//   全部片段 TS 化完成、按拼回后的联合视图接线后再移除本 pragma。

/**
 * 会话身份：从 URL 取会话 ID、从 hash 取 sid、并在变化时上报工作台。
 * [WHY] 工作台靠 (id, sessionId) 定位当前对话；上报时机错过一次，
 *   后续所有回传都会被归到旧会话，表现为「AI 明明回复了但工作台看不到」。
 * [CONSTRAINT] 规则顺序即优先级：越具体的路径模板越靠前，
 *   通用兜底（如 qianwen.aliyun.com 的长 ID 抓取）放末尾。
 */

/** 站点会话 URL 规则：正则 + 捕获组序号（1-based） */
const RULES: SidRule[] = [
  { re: /chat\.deepseek\.com\/a\/chat\/s\/([\w-]+)/, n: 1 },
  { re: /chatgpt\.com\/c\/([\w-]+)/, n: 1 },
  { re: /chat\.openai\.com\/c\/([\w-]+)/, n: 1 },
  { re: /claude\.ai\/chat\/([\w-]+)/, n: 1 },
  { re: /kimi\.moonshot\.cn\/chat\/([\w-]+)/, n: 1 },
  { re: /gemini\.google\.com\/app\/([\w-]+)/, n: 1 },
  { re: /tongyi\.aliyun\.com\/qianwen\/([\w-]+)/, n: 1 },
  { re: /qianwen\.aliyun\.com\/[\w-]*\/?([\w-]{20,})/, n: 1 },
  // [qianwen-web-v1] 千问网页版主域名已切至 qianwen.com，会话形如 /chat|/c|/q/{id}；
  //   域名锚定避免误匹配其它站点；顺序置末尾保留既有优先级。
  { re: /(?:www\.)?qianwen\.com\/(?:chat|c|q)\/([\w-]+)/, n: 1 },
  // [chatglm-adapter-v1] 智谱清言会话 URL：/main/detail/{id}
  { re: /chatglm\.cn\/main\/detail\/([\w-]+)/, n: 1 },
]

let lastId = ''
let lastSid = ''

/**
 * 本实例是否已报告过「启动」。
 * [WHY] 仅首次 send() 携带 boot:true，供客户端识别 AI 窗口刚加载（新上下文）；
 *   F5 后新实例会重新置 false，站点内切会话触发的后续 send() 不带该标记。
 */
let _bootSent = false

/** 从 URL hash 取 sid（形如 #sid=xxx 或 &sid=xxx） */
function extractSidFromHash(): string {
  const m = location.hash.match(/(?:^#|&)sid=([\w.-]+)/)
  return m ? m[1] : ''
}

/** 按 RULES 顺序从当前 URL 提取会话 ID；全不命中返回空串（不是错误状态） */
function extractId(): string {
  const href = location.href
  for (let i = 0; i < RULES.length; i++) {
    const m = href.match(RULES[i].re)
    if (m) return decodeURIComponent(m[RULES[i].n])
  }
  return ''
}

/**
 * 会话身份变化时上报。
 * [CONSTRAINT] boot 标记必须在「判断是否变化」之后、发送之前置位，
 *   否则 opener 未建立时会被后续 send() 反复判为「首发」。
 */
function send(): void {
  const id = extractId()
  const sid = extractSidFromHash()
  let changed = false
  if (id && id !== lastId) { lastId = id; changed = true }
  if (sid !== lastSid) { lastSid = sid; changed = true }
  if (!changed) return
  const _isBoot = !_bootSent
  _bootSent = true
  try {
    if (window.opener && !window.opener.closed) {
      post({ type: 'ai-runner:session-id', id, sessionId: extractSidFromHash(), boot: _isBoot })
    }
  } catch { /* opener 受限：本条已入断链队列，恢复后补发 */ }
}
