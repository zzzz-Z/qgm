// @ts-nocheck
// [tampermonkey-ts-rewrite-v1] IIFE 物理切分片段，非独立模块；跨片段符号在单文件检查下不可见。
//   全部片段 TS 化完成、按拼回后的联合视图接线后再移除本 pragma。

/**
 * 正文剥壳扫描与「会话触顶」探针。
 * [WHY] 工作台会把脚本 stdout 用围栏回填进会话，页面里落成 <pre><code>；
 *   而源码/文档里含探针自己的词表 ⇒ 整页 textContent 会自指命中，
 *   误报「已达长度上限」并掐掉一整轮（实测：剥壳后命中数 1 → 0）。
 * [CONSTRAINT] 只有「标记类」探针走剥壳文本；
 *   篇幅/增长类判据（bodySignature / stillStreamingReply）必须读整页 raw ——
 *   代码块属于回复正文，剥掉会让「正文是否仍在增长」失真。
 */

let _scanRaw: string | null = null
let _scanText = ''

/**
 * 剥掉代码块、输入框与可编辑区后的正文文本。
 * [CONSTRAINT] 实现体与 headless-inject.ts / headless-fill.ts 两处同构
 *   （守卫测试 limit-marker-guard 的 body-text parity 用例对拍）。
 */
function bodyText(): string {
  const b = document.body
  if (!b) return ''
  const c = b.cloneNode(true) as HTMLElement
  const kill = c.querySelectorAll('pre,code,textarea,input,[contenteditable="true"],script,style')
  for (let i = 0; i < kill.length; i++) kill[i].remove()
  return c.textContent || ''
}

/**
 * 共享的剥壳快照。
 * [WHY] classifyAndPost 每 350ms 一跑，每次 clone 整页代价过高；
 *   先用整页 raw 做字符串比较（零额外节点分配），仅在 raw 变化时剥壳一次。
 */
function scanBodyText(): string {
  const t = (document.body && document.body.textContent) || ''
  if (t === _scanRaw) return _scanText
  _scanRaw = t
  _scanText = bodyText()
  return _scanText
}

/**
 * 会话长度上限标记计数。
 * [CONSTRAINT] 正则必须覆盖两种语序：「达到对话长度上限」（动词在前，DeepSeek 实际文案）
 *   与「对话长度已达上限」（名词在前）；且「上限」后必须自带动作子句，
 *   否则正文自指 + 侧栏常驻「开启新对话」按钮的拼接会造成假命中。
 * [CONSTRAINT] 英文分支必须邻近 token 数：裸 matching `maximum context length` 会被
 *   回填进会话的源码行自指命中。三处（本文件 / headless-inject / headless-fill）
 *   必须严格同构，守卫测试 limit-marker-guard 对拍。
 */
function countLimitMarkers(): number {
  try {
    const m = scanBodyText().match(/(?:(?:达到|已达|超出|超过)\s*(?:对话|会话|上下文)(?:长度)?\s*(?:上限|最大长度|超限|过长)|(?:对话|会话|上下文)(?:长度)?\s*(?:已达|已达到|达到|超出|超过)\s*(?:上限|最大长度|超限|过长)|(?:对话|会话|上下文)(?:长度)?超限|(?:对话|会话|上下文)(?:长度)?\s*(?:上限|最大长度|过长))(?:[，,：:]\s*请?|请)(?:开启|开始|新建|创建)(?:一个)?新(?:对话|会话)|context length (?:limit|exceeded|too long)|maximum context length (?:is|of)\s*\d+|maximum context length\s+\d+\s*tokens/gi) || []
    if (m.length) limitMarkerText = m[m.length - 1]
    return m.length
  } catch { return 0 }
}

/**
 * 以当前存量为新一轮基线。
 * [WHY] 存量触顶标记（会话早就满了）不应被当成「本轮新增」而立刻触发轮转；
 *   基线只对「本轮增量」负责。
 */
function syncLimitMarkerBaseline(): void {
  limitMarkerBaseline = countLimitMarkers()
  assistantRootBaseline = countAssistantRoots()
}
