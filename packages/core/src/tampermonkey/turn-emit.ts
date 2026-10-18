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
 * [CONSTRAINT] 去重键是 `turn|blockId` 而非内容 hash：同一信封会被 MutationObserver
 *   反复扫到，按内容 hash 去重会把「同 id 改了内容」的块也一并挡掉（R2 要求后到覆盖先到）。
 */

/** 已推送过的 `turn|blockId`；跨 poll 保留（turnId 单调递增，旧条目自然失效） */
const seenTurnBlocks: Set<string> = new Set()

/** 已推过结束帧的 turnId；同一信封重复扫到时不得重复发 */
const endedTurnIds: Set<number> = new Set()

/** 去重集合上限；超了整体清空（信封 turnId 单调递增，清空不会造成重推） */
const TURN_SEEN_MAX = 800

function turnBlockKey(turnId: number, blockId: string): string {
  return `${turnId}|${blockId}`
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
    if (type !== 'say' && type !== 'script' && type !== 'ask' && type !== 'handoff') {
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
  const end: any = { turnId, awaiting: turnAwaiting(blocks), blocks: blocks.length }
  if (skipped.length > 0) end.skipped = skipped
  return { blocks, end }
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
    if (!pres || !pres.length) return null
    for (let i = pres.length - 1; i >= 0; i--) {
      const pre = pres[i]
      const codeEl = pre && typeof pre.querySelector === 'function' ? pre.querySelector('code') : null
      const raw = (codeEl && codeTextOf(codeEl)) || (pre && pre.textContent) || ''
      if (!raw) continue
      const r = parseTurn(raw)
      if (!r || !r.blocks || r.blocks.length === 0) continue
      if (r.truncated) return null
      return { turnId: typeof r.turn === 'number' ? r.turn : 0, blocks: r.blocks, errors: r.errors || [] }
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
  let sent = 0
  for (let i = 0; i < frames.blocks.length; i++) {
    const block = frames.blocks[i]
    const key = turnBlockKey(block.turnId, block.blockId)
    if (seenTurnBlocks.has(key)) continue
    seenTurnBlocks.add(key)
    if (seenTurnBlocks.size > TURN_SEEN_MAX) {
      seenTurnBlocks.clear()
      seenTurnBlocks.add(key)
    }
    post({
      type: 'ai-runner:block',
      block,
      site: location.origin,
      sessionId: sid,
    })
    sent++
  }
  const endKey = turn.turnId
  if (!endedTurnIds.has(endKey)) {
    endedTurnIds.add(endKey)
    if (endedTurnIds.size > TURN_SEEN_MAX) {
      endedTurnIds.clear()
      endedTurnIds.add(endKey)
    }
    post({
      type: 'ai-runner:turn-end',
      end: frames.end,
      site: location.origin,
      sessionId: sid,
    })
  }
  if (sent > 0) lastBodySig = bodySignature()
  return true
}
