// @ts-nocheck
// [tampermonkey-ts-rewrite-v1] IIFE 物理切分片段，非独立模块；跨片段符号在单文件检查下不可见。
//   全部片段 TS 化完成、按拼回后的联合视图接线后再移除本 pragma。

/**
 * 脚本块提取 —— 从最后一条 AI 回复里挑出「首个尚未推送的合格代码块」。
 *
 * 三道门，任一不放行都不能推：
 *   ① 语言白名单（js / bash，脚本头契约兜底为 js）——推 python/json 给 node 必然语法错；
 *   ② 可执行内容门 —— 只有头部注释的残缺块不算完整脚本；
 *   ③ 结构闭合门 —— 括号/引号未闭合极可能是流式半截，先等，等不到才按「上游真截断」放行。
 *
 * [WHY] 这三道门都是被真实事故逼出来的：
 *   · 只有防抖 + 生成中门时，流式中途任何一次超过窗口的停顿都会让半截块被判为完整；
 *   · 括号闭合门对「纯注释」天然为 false，于是只有头部的块被当完整脚本推出去，前端跑两次；
 *   · 旧实现只取最后一块，前面的块被静默丢弃，而最后一块恰是截断最可能切中的那块。
 * [CONSTRAINT] 本段与 headless-inject.ts 的 extractLatestScript 语义必须同构
 *   （那边查固定选择器，这边走站点无关的 latestAssistantRoot），
 *   由 script-closure-gate / multi-script-blocks 用假 DOM 对拍锁死。改一处必须同步另一处。
 */

/** 提取结果：语言、代码正文、内容指纹 */
interface ScriptItem {
  lang: string
  code: string
  hash: string
}

/**
 * 括号/引号闭合扫描：返回 true 表示**未闭合**（不可直接推送）。
 * [CONSTRAINT] 语义必须与 packages/core/src/post-run/script-check.ts 的 hasUnclosedStructure
 *   一致（那边是服务端判据），由 script-closure-gate 用例做语料对拍。
 * [WHY] 手写状态机而非正则：正则无法正确处理「字符串里的括号」与「注释里的引号」。
 */
function hasUnclosedStructureJs(src: string): boolean {
  const stack: string[] = []
  let state = 'code'
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    const nx = src[i + 1]
    if (state === 'line-comment') { if (ch === '\n' || ch === '\r') state = 'code'; continue }
    if (state === 'block-comment') { if (ch === '*' && nx === '/') { state = 'code'; i++ } continue }
    if (state === 'single' || state === 'double' || state === 'template') {
      const q = state === 'single' ? "'" : state === 'double' ? '"' : '`'
      if (ch === '\\') { i++; continue }
      if (ch === q) state = 'code'
      continue
    }
    if (ch === '/' && nx === '/') { state = 'line-comment'; i++; continue }
    if (ch === '/' && nx === '*') { state = 'block-comment'; i++; continue }
    if (ch === "'") { state = 'single'; continue }
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

/**
 * 剔除 shebang / 注释 / 空白后是否还有可执行内容。
 * [CONSTRAINT] 与 headless-inject.ts 同名函数逐字同构；判据与
 *   packages/client/composables/runner/inbox-parse.ts 的 normalizeForHash 同义。
 */
function hasExecutableContent(src: string): boolean {
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

/**
 * 「回复仍在增长」判定：正文长度变了就继续等；连续 3 次等长则视为上游真截断并放行。
 * [CONSTRAINT] 门状态挂在 window 上（不用闭包变量）——本段与内置通道逐字同构，
 *   内置通道经 page.evaluate 序列化执行，引用外部闭包会丢。
 */
function stillStreamingReply(): boolean {
  const body = String((document.body && document.body.textContent) || '')
  const w = window as any
  const gate = w.__aiRunnerClosureGate
  if (!gate || gate.len !== body.length) {
    w.__aiRunnerClosureGate = { len: body.length, ticks: 0 }
    return true
  }
  gate.ticks++
  return gate.ticks < 3
}

/** 脚本头契约：shebang 或 @desc 头 —— 站点漏标语言时据此兜底为 js */
function hasScriptHead(text: string): boolean {
  return /^#!\s*\/usr\/bin\/env\s+(?:node|bash)\b/m.test(text)
    || /^\s*\/\/\s*@desc\b/m.test(text)
    || /^\s*#\s*@desc\b/m.test(text)
}

/**
 * 提取「首个尚未推送」的合格脚本块。
 * [CONSTRAINT] 只扫最后一条 AI 回复容器内的 <pre>；容器缺失（新会话首轮思考阶段）
 *   不得退回整页 —— 否则用户首条消息里的代码块会被当脚本候选。
 * [CONSTRAINT] 本回复内存在任意**标记块**时，无标记块视为片段不推（fragment-guard）：
 *   标记块才算「AI 明确要交付的脚本」，其余可能只是示例。
 */
function extractLatestScript(): ScriptItem | null {
  const root = latestAssistantRoot()
  const pres = root ? root.querySelectorAll('pre') : []
  let firstUnseen: ScriptItem | null = null
  let firstUnseenMarked: ScriptItem | null = null
  let hasAnyMarked = false

  for (const pre of Array.from(pres)) {
    // 优先从 <pre><code> 取文本：pre.textContent 会把代码块头的语言标签与「复制/下载」按钮并入首行
    const codeEl = pre.querySelector('code') || pre
    const text = codeTextOf(codeEl)
    if (!text) continue
    if (!text.includes('\n') && text.length < 120) continue

    // 语言判定四级回退：className → DOM 邻近探测 → 内容特征 → 脚本头契约
    let lang: string | null = guessLangFromClass(codeEl) || guessLangFromDom(pre) || guessLangFromContent(text) || null
    const marked = hasScriptHead(text)
    if (!lang && marked) lang = 'js'
    // [script-lang-whitelist-v2] 取消「声明 SCRIPT 即无条件放行」：声明时连语言都判不出的块
    //   （python / json / 无标签）不再收——前端把 null 折算成 js 交给 node 必然语法错。
    if (lang !== 'js' && lang !== 'bash') continue
    if (!hasExecutableContent(text)) continue
    // 未闭合先等；等不到（连续 3 帧等长）才按上游真截断放行，走下游 400 补救路径
    if (hasUnclosedStructureJs(text)) {
      if (stillStreamingReply()) continue
    }

    const item: ScriptItem = { lang, code: text, hash: hash32(text) }
    // marked 必须在 seen 跳过**之前**计算：已推送过的标记块也要计入 hasAnyMarked，
    // 否则第二次 pick 会误判「本回复无标记块」而把片段兜底推出去
    if (marked) hasAnyMarked = true
    if (seenHashes.has(item.hash)) continue
    if (!firstUnseen) firstUnseen = item
    if (marked && !firstUnseenMarked) firstUnseenMarked = item
  }

  if (firstUnseenMarked) return firstUnseenMarked
  if (hasAnyMarked) return null
  return firstUnseen
}

/**
 * 是否还有未推送的合格块 —— 决定推完一块后要不要主动再跑一次分类。
 * [WHY] 本通道靠 MutationObserver 唤醒；推完第一块后 DOM 已静止，
 *   observer 不会再触发，同一回复里的第 2、3 个脚本会一直躺着不发。
 */
function hasMoreUnseenBlocks(): boolean {
  try {
    const s = extractLatestScript()
    return Boolean(s && !seenHashes.has(s.hash))
  } catch { return false }
}

/**
 * DOM 提取失败时的 Markdown 围栏兜底。
 * [WHY] 部分站点的代码块不用标准 <pre><code> 结构，extractLatestScript 找不到
 *   ⇒ 整条回复降级成 plain 文本（表现为「渲染了但没执行」）。
 * [CONSTRAINT] 只从最后一条 AI 回复里取；语言白名单同为 js / bash / cjs。
 */
function extractScriptFromMarkdown(): ScriptItem | null {
  try {
    const root = latestAssistantRoot()
    if (!root) return null
    const md = extractReplyMd(root)
    const fenceRe = /```(\w*)\n([\s\S]*?)```/g
    let m: RegExpExecArray | null
    let last: ScriptItem | null = null
    while ((m = fenceRe.exec(md)) !== null) {
      const rawLang = (m[1] || '').toLowerCase()
      const code = m[2].replace(/^\n+|\n+$/g, '')
      if (!code || (!code.includes('\n') && code.length < 120)) continue
      let lang: string | null = rawLang === 'javascript' || rawLang === 'node' || rawLang === 'js'
        ? 'js'
        : rawLang === 'sh' || rawLang === 'shell' || rawLang === 'bash'
          ? 'bash'
          : rawLang === 'cjs' ? 'cjs' : null
      if (!lang) lang = guessLangFromContent(code)
      if (lang !== 'cjs' && lang !== 'js' && lang !== 'bash') continue
      last = { lang, code, hash: hash32(code) }
    }
    return last
  } catch { return null }
}
