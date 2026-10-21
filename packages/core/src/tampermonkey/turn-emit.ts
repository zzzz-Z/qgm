// @ts-nocheck
// [tampermonkey-ts-rewrite-v1] IIFE 物理切分片段，非独立模块；跨片段符号在单文件检查下不可见。
//   全部片段 TS 化完成、按拼回后的联合视图接线后再移除本 pragma。

/**
 * turn 信封 → 块帧 / 结束帧（油猴侧，P3）。
 *
 * [WHY] 信封到达时「整轮内容」是一次性确定的对象，不再需要 extractLatestScript 那三道
 *   流式门（语言白名单 / 闭合门 / 内容门）—— 块已经带 `lang` 且 code 是 JSON 里的完整字符串。
 *   继续走旧路径的后果是：信封 JSON 会被语言判定当成 json 拒掉，整条回复降级为 plain，
 *   用户看到一坨 JSON 上屏且脚本一个都不执行。
 *
 * [CONSTRAINT] 帧 shape 与「块字段收窄」必须与核心 `packages/core/src/reply/turn-frames.ts`
 *   完全同构，由 turn-emit-parity 用例做**行为对拍**（同一批块两端产出的帧必须逐字节相同）。
 *   这条判据承重的原因：一旦某端多带一个字段（例如 say 帧带上 code），前端的「采信守卫」
 *   就再也测不出「值是从别的字段抄来的」。
 *
 * [CONSTRAINT] 去重键是 `<sid>|<turnId>|<blockId>` 而非内容 hash：同一信封会被 MutationObserver
 *   反复扫到，按内容 hash 去重会把「同 id 改了内容」的块也一并挡掉（R2 要求后到覆盖先到）。
 *   sid 前缀承重：不同会话的 turnId 各自从 1 起算，不带 sid 会让两个会话的「turn 3」互相顶掉。
 */

/**
 * [turn-emit-dedup-persist-v1] 去重集合落 sessionStorage。
 * [WHY] 集合此前只在页面内存里：刷新后 MutationObserver 会重新扫到同一条 AI 回复，
 *   集合已随页面清空 ⇒ 同一信封被重推 ⇒ 前端执行账本同样为空 ⇒ **上一轮脚本被重跑**（P0-1b）。
 *   sessionStorage 与页面同生命周期但跨刷新存活，正好覆盖「只跨刷新、不跨新标签」的缺口。
 */
const TURN_SEEN_STORE = 'aiRunner.turnSeenBlocks.v1'
const TURN_ENDED_STORE = 'aiRunner.turnEndedIds.v1'

/** 读回持久化的去重集合；不可用（隐私模式 / 非浏览器上下文）⇒ 空集，降级为纯内存去重 */
function loadKeySet(storeKey: string): Set<string> {
  const out: Set<string> = new Set()
  try {
    if (typeof sessionStorage === 'undefined') return out
    const raw = sessionStorage.getItem(storeKey)
    if (!raw) return out
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return out
    for (let i = 0; i < arr.length; i++) {
      if (typeof arr[i] === 'string') out.add(arr[i] as string)
    }
    return out
  } catch { return new Set<string>() }
}

/** 写回去重集合；写失败只影响「跨刷新去重」这一增益，不影响本轮行为 */
function persistKeySet(storeKey: string, set: Set<string>): void {
  try {
    if (typeof sessionStorage === 'undefined') return
    sessionStorage.setItem(storeKey, JSON.stringify(Array.from(set)))
  } catch { /* 配额 / 隐私模式：降级为纯内存去重 */ }
}

/** 已推送过的 `<sid>|<turnId>|<blockId>`；跨 poll 且跨刷新保留 */
const seenTurnBlocks: Set<string> = loadKeySet(TURN_SEEN_STORE)

/** 已推过结束帧的 `<sid>|<turnId>`；同一信封重复扫到时不得重复发 */
const endedTurnIds: Set<string> = loadKeySet(TURN_ENDED_STORE)

/** 去重集合上限；超了淘汰最旧（信封 turnId 单调递增，淘汰最旧不会造成重推） */
const TURN_SEEN_MAX = 800

/** 淘汰最旧条目：Set 保持插入序，values().next() 即最早插入的那个 */
function evictOldest(set: Set<string>): void {
  const oldest: unknown = set.values().next().value
  if (typeof oldest === 'string') set.delete(oldest)
}

function turnBlockKey(sid: string, turnId: number, blockId: string): string {
  return `${sid}|${turnId}|${blockId}`
}
/** [conv-gen-isolation-v1] 会话代际：同 sid 下切新对话时 turnId 从 1 重编号，
 *  旧去重键 sid|turnId|blockId 会碰撞吞块（实测整轮无响应，须重开标签页才恢复）。
 *  [WHY] 检测 turnId 回退即轮转代际；gen 持久化，跨刷新去重不受影响。 */
const CONV_GEN_STORE = 'aiRunner.convGen.v1'
const CONV_MAXTURN_STORE = 'aiRunner.convMaxTurn.v1'
const CONV_LASTSID_STORE = 'aiRunner.convLastSid.v1'
function loadConvGen(): number {
  try {
    if (typeof sessionStorage === 'undefined') return 0
    return Number(sessionStorage.getItem(CONV_GEN_STORE) || 0) || 0
  }
  catch { return 0 }
}
function loadConvMaxTurn(): number {
  try {
    if (typeof sessionStorage === 'undefined') return 0
    return Number(sessionStorage.getItem(CONV_MAXTURN_STORE) || 0) || 0
  }
  catch { return 0 }
}
function loadConvLastSid(): string {
  try {
    if (typeof sessionStorage === 'undefined') return ''
    return sessionStorage.getItem(CONV_LASTSID_STORE) || ''
  }
  catch { return '' }
}
let convGen = loadConvGen()
function bumpConvGenIfNewConversation(turnId: number, sid?: string): void {
  if (typeof turnId !== 'number') return
  let bumped = false
  // 主判据：会话标识变化（与 turnId 编号方式无关，可真正区分「换了对话」）
  if (sid) {
    const lastSid = loadConvLastSid()
    if (lastSid && lastSid !== sid) {
      convGen += 1
      bumped = true
    }
    try { sessionStorage.setItem(CONV_LASTSID_STORE, sid) }
    catch {}
  }
  // 兜底：拿不到 sid 时退回 turnId 回退判据（历史行为）
  const maxTurn = loadConvMaxTurn()
  if (!bumped && maxTurn > 0 && turnId < maxTurn) {
    convGen += 1
    bumped = true
  }
  if (bumped) {
    try { sessionStorage.setItem(CONV_GEN_STORE, String(convGen)) }
    catch {}
  }
  if (turnId > maxTurn) {
    try { sessionStorage.setItem(CONV_MAXTURN_STORE, String(turnId)) }
    catch {}
  }
}


/**
 * 本轮结束后循环等什么。优先级 **script > ask > none**（与核心 deriveAwaiting 同构）。
 * [WHY] 不让前端各自推导：三处推导必然在「既有 script 又有 ask」上分叉，
 *   而分叉的后果是循环要么空转要么提前结束，且没有任何一处报错。
 */
function turnAwaiting(blocks: any[]): string {
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

/**
 * 单块收窄。返回字符串 = 跳过的原因（缺哪个字段），返回对象 = 可用的帧。
 * [CONSTRAINT] 只输出该类型**该有**的字段：把 `code` 塞进 say 帧会让前端有机会读错字段。
 */
function turnToFrame(turnId: number, blockId: string, seq: number, type: string, b: any): any {
  if (type === 'say') {
    const text = typeof b.text === 'string' ? b.text : ''
    if (!text.trim()) return 'text'
    return { turnId, blockId, seq, type, text }
  }
  if (type === 'handoff') {
    const summary = typeof b.summary === 'string' ? b.summary : ''
    if (!summary.trim()) return 'summary'
    return { turnId, blockId, seq, type, summary }
  }
  if (type === 'ask') {
    const question = typeof b.question === 'string' ? b.question : ''
    if (!question.trim()) return 'question'
    const options: any[] = []
    const rawOptions = Array.isArray(b.options) ? b.options : []
    for (let i = 0; i < rawOptions.length; i++) {
      const o = rawOptions[i]
      const label = o && typeof o.label === 'string' ? o.label : ''
      if (!label.trim()) continue
      const oid = o && typeof o.id === 'string' && o.id ? o.id : `opt_${options.length + 1}`
      options.push({ id: oid, label })
    }
    return { turnId, blockId, seq, type, question, options }
  }
  if (type === 'done') {
    const summary = typeof b.summary === 'string' ? b.summary : ''
    if (!summary.trim()) return 'summary'
    const commit = typeof b.commit === 'string' ? b.commit.trim() : ''
    return { turnId, blockId, seq, type, summary, ...(commit ? { commit } : {}) }
  }
  // script
  const lang = typeof b.lang === 'string' ? b.lang : ''
  const code = typeof b.code === 'string' ? b.code : ''
  const desc = typeof b.desc === 'string' ? b.desc : ''
  const why = typeof b.why === 'string' ? b.why : ''
  if (!code.trim()) return 'code'
  if (lang !== 'js' && lang !== 'cjs') return 'lang'
  if (!desc.trim()) return 'desc'
  if (!why.trim()) return 'why'
  return { turnId, blockId, seq, type, lang, desc, why, code }
}

/**
 * 块列表 → `{ blocks, end }`（与核心 blocksToFrames 同构）。
 * [CONSTRAINT] `seq` 取输入数组下标而非「已发块计数」：跳过的块要在 seq 上留空洞，
 *   前端据此能发现「说好的第 3 块没来」，而不是把第 4 块错位当成第 3 块。
 */
function turnBlocksToFrames(turnId: number, raw: any[]): any {
  const blocks: any[] = []
  const skipped: string[] = []
  const list = Array.isArray(raw) ? raw : []
  for (let i = 0; i < list.length; i++) {
    const b = list[i] || {}
    const id = typeof b.id === 'string' ? b.id : `#${i + 1}`
    const type = typeof b.type === 'string' ? b.type : ''
    if (type !== 'say' && type !== 'script' && type !== 'ask' && type !== 'handoff' && type !== 'done') {
      skipped.push(`${id}:type`)
      continue
    }
    const frame = turnToFrame(turnId, id, i, type, b)
    if (typeof frame === 'string') {
      skipped.push(`${id}:${frame}`)
      continue
    }
    blocks.push(frame)
  }
  // [turn-mode-v1] mode 与核心 deriveTurnMode 同构：awaiting==='none' ⇒ 总结轮。
  // [CONSTRAINT] 本片段不可 import（IIFE 物理切分），只能逐字同构；
  //   漏掉本字段会让油猴通道的 turn-end 缺失 mode，前端退化为按 awaiting 推断。
  const awaiting = turnAwaiting(blocks)
  const end: any = { turnId, awaiting, mode: awaiting === 'none' ? 'summary' : awaiting, blocks: blocks.length }
  if (skipped.length > 0) end.skipped = skipped
  return { blocks, end }
}

/**
 * 收集围栏外的**散文**文本（只认 `<p>/<li>/<h1>-<h6>/<blockquote>/<td>/<th>` 内的文本节点，
 * 跳过 `<pre>` / `<script>` / `<style>`，并整棵剪掉 `button/a/svg` 与 `aria-hidden="true"` 子树）。
 * [WHY 只认散文元素] 初版遍历容器下全部非 pre 文本节点，把 DeepSeek 代码块**自带 UI** 也当成了
 *   围栏外文本——语言标签 `json`、复制/下载按钮文字都在容器里且不在 pre 内 ⇒ AI 明明一个字
 *   没写也被「回收」成假 say 块（用户实测 2026-10-20，diag len=87 全是界面文字）。
 *   markdown 正文只会渲染成 p/li/标题/引用/表格单元格 ⇒ 以元素类别划界即可精确区分
 *   「AI 写的话」与「页面的界面文字」，不依赖任何站点特化选择器。
 * [CONSTRAINT] 只在信封已合法解析的前提下调用；无围栏的裸 JSON 回退分支不触发（避免把 JSON 自身算进 outside）。
 * [CONSTRAINT] 不读全局状态、不依赖任何模块 —— 与 parseTurn 同属「可独立序列化」的纯逻辑。
 */
function outsideFenceText(root: any): string {
  if (!root || typeof root.childNodes === 'undefined') return ''
  let out = ''
  const PROSE: Record<string, boolean> = { P: true, LI: true, H1: true, H2: true, H3: true, H4: true, H5: true, H6: true, BLOCKQUOTE: true, TD: true, TH: true }
  const walk = (node: any, inProse: boolean): void => {
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

/**
 * 从最后一条 AI 回复里读信封（与无头侧 readTurnBlocks 同构）。
 * [CONSTRAINT] 从后往前扫、命中即返回：一条回复里若有多个围栏，信封永远是最后交付的那个。
 * [CONSTRAINT] `truncated` ⇒ 返回 null 而不是把半截信封当完整交付。
 */
function readTurnFromRoot(root: any): any {
  try {
    if (!root || typeof root.querySelectorAll !== 'function') return null
    const pres = root.querySelectorAll('pre')
    if (pres && pres.length) {
      for (let i = pres.length - 1; i >= 0; i--) {
        const pre = pres[i]
        const codeEl = pre && typeof pre.querySelector === 'function' ? pre.querySelector('code') : null
        const raw = (codeEl && codeTextOf(codeEl)) || (pre && pre.textContent) || ''
        if (!raw) continue
        const r = parseTurn(raw)
        if (!r || !r.blocks || r.blocks.length === 0) continue
        if (r.truncated) return null
        // [text-outside-fence-v1] 信封合法但围栏外有文本 ⇒ 回收成 say 块，避免被静默丢弃。
        //   [WHY] parseTurn 只解析围栏内对象，围栏外文本既不进块也不报错 ⇒ 用户写的说明蒸发且零诊断。
        //   [CONSTRAINT] 回收块 id 用 `outside_<turnId>`：与信封内块不冲突，且刷新后同输入重算同 id ⇒ 去重不重推。
        //   [CONSTRAINT] 只走 `<pre>` 分支：裸 JSON 回退分支里 leading 文本会被 parseTurn 判成 TURN_NOT_JSON，
        //     走 turn-invalid 通道由工作台纠正（方案4），不在此回收（避免把 JSON 自身算进 outside）。
        const outside = outsideFenceText(root)
        const blocks = r.blocks.slice()
        if (outside) {
          blocks.push({ type: 'say', id: `outside_${typeof r.turn === 'number' ? r.turn : 0}`, text: outside })
          r.errors = (r.errors || []).concat([{ code: 'TEXT_OUTSIDE_FENCE', detail: `围栏外文本 ${outside.length} 字已回收为 say 块` }])
          if (typeof _tmDiag === 'function') _tmDiag('text-outside-fence', { turnId: typeof r.turn === 'number' ? r.turn : 0, len: outside.length, head: outside.slice(0, 80) })
        }
        return { turnId: typeof r.turn === 'number' ? r.turn : 0, blocks, errors: r.errors || [] }
      }
    }
    // [no-fence-envelope-v1] 无 <pre> 信封（回复未加 ```json 围栏）⇒ 回退解析整条回复文本。
    //   无围栏时裸 JSON 不进 <pre>，只扫 <pre> 会整轮找不到信封 ⇒ 回落 plain 把 JSON 正文推上屏、
    //   脚本零执行（用户实测 2026-10-19）。parseTurn 已支持以左花括号开头的裸 JSON，
    //   且要求存在非空 content ⇒ 普通文本 / 非信封 JSON 仍返回 null，不误吞。
    // [CONSTRAINT] 函数体内注释不得出现字面花括号：守卫抠函数体时会做朴素花括号配对，会被注释里的括号带偏。
    const rawText = String((root && root.textContent) || '')
    if (rawText) {
      const r = parseTurn(rawText)
      if (r && r.blocks && r.blocks.length > 0 && !r.truncated) {
        return { turnId: typeof r.turn === 'number' ? r.turn : 0, blocks: r.blocks, errors: r.errors || [] }
      }
    }
    return null
  } catch { return null }
}

/**
 * 把一个信封推成帧。
 * @returns 本轮内容是否**由信封承载**（true ⇒ 调用方必须 return，不得再走 script / plain）
 * [CONSTRAINT] 重复扫到同一信封时一帧都不发，但仍返回 true：
 *   若返回 false，dispatch 会回落到 plain 分支把信封 JSON 正文推上屏。
 * [CONSTRAINT] 没有任何可用块（全被字段校验跳过）⇒ 返回 false：此时确实退化成旧路径，
 *   让 script / plain 有机会兜住（半截块至少能靠 plain 让用户看见）。
 */
function emitTurn(turn: any): boolean {
  if (!turn || !turn.blocks || !turn.blocks.length) return false
  const frames = turnBlocksToFrames(turn.turnId, turn.blocks)
  if (!frames.blocks.length) return false
  const sid = extractSidFromHash()
  bumpConvGenIfNewConversation(turn.turnId, sid)
  let sent = 0
  let dirty = false
  for (let i = 0; i < frames.blocks.length; i++) {
    const block = frames.blocks[i]
    const key = turnBlockKey(`${sid}|${convGen}`, block.turnId, block.blockId)
    if (seenTurnBlocks.has(key)) continue
    seenTurnBlocks.add(key)
    dirty = true
    if (seenTurnBlocks.size > TURN_SEEN_MAX) evictOldest(seenTurnBlocks)
    post({
      type: 'ai-runner:block',
      block,
      site: location.origin,
      sessionId: sid,
    })
    sent++
  }
  const endKey = `${sid}|${convGen}|${turn.turnId}`
  if (!endedTurnIds.has(endKey)) {
    endedTurnIds.add(endKey)
    dirty = true
    if (endedTurnIds.size > TURN_SEEN_MAX) evictOldest(endedTurnIds)
    post({
      type: 'ai-runner:turn-end',
      end: frames.end,
      site: location.origin,
      sessionId: sid,
    })
  }
  if (sent > 0) lastBodySig = bodySignature()
  // [dedup-swallow-diag-v1] 信封读到了但**全部块被去重集合吃掉**（sent=0）⇒ 此前完全静默：
  //   emitTurn 返回 true ⇒ dispatch 静默 return ⇒ 不发块、不报 turn-invalid、工作台空白、零日志。
  //   实测成因（2026-10-20）：工作台复用同一 DeepSeek 标签页（同 sid hash），sessionStorage 去重集合
  //   里存着早前会话的 `sid|turnId|blockId`；新对话 turn 重新从 1 编号且块 id 惯用 s1/c1 ⇒ 键碰撞 ⇒ 全吞。
  //   [WHY 用正文签名门] MutationObserver 会让本函数对同一信封高频重扫，不带门会刷屏。
  //   [CONSTRAINT] 只报判据不报正文；正文签名与 _invalidReportedSig 同构（静止时只报一次）。
  if (sent === 0 && !dirty && frames.blocks.length > 0) {
    const swallowSig = bodySignature()
    if (swallowSig !== (globalThis as any).__aiDedupDiagSig) {
      ;(globalThis as any).__aiDedupDiagSig = swallowSig
      if (typeof _tmDiag === 'function') {
        _tmDiag('dedup-swallow', {
          turnId: turn.turnId,
          frames: frames.blocks.length,
          note: '信封已读到但全部块命中去重集合（同 sid+turnId+blockId 曾投递过）。若这是新对话，请关掉 AI 标签页重开以清空 sessionStorage 去重集合。',
        })
      }
    }
  }
  // [turn-emit-dedup-persist-v1] 只有真新增了去重键才落盘：无新帧的重复扫描不该写存储。
  if (dirty) {
    persistKeySet(TURN_SEEN_STORE, seenTurnBlocks)
    persistKeySet(TURN_ENDED_STORE, endedTurnIds)
  }
  return true
}
