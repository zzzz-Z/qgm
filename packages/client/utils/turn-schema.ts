/* @turn-schema:8ce160d15ffe92ec */
// 由 scripts/sync-turn-schema.mjs 从 packages/core/src/reply/turn-schema.ts 生成，请勿手改。
/* eslint-disable ts/ban-ts-comment -- 纯 JS 源，由 scripts/sync-turn-schema.mjs 生成 */
// @ts-nocheck

// >>> BEGIN turn-schema
// [turn-schema-v1] turn 信封契约的**唯一源**。
//
// 为什么是唯一源：本文件会被 scripts/sync-turn-schema.mjs 复制成三份产物
// （无头内联段 / 油猴片段 / 前端副本），三份头部各带 `/* @turn-schema:<hash> */`，
// 由 reply-turn-fingerprint 守卫重算源哈希比对 —— 「三处同一份源码」是判据，不是承诺。
//
// [CONSTRAINT] 本文件必须保持「纯 JS 可执行」：
//   · 不写 TS 注解（生成器直接复制，不做类型擦除）
//   · 不 import 任何模块（无头侧 page.evaluate 不能加载模块）
//   · 不用 Date / Math.random（解析必须幂等，同输入同输出）
//   · 不读全局状态（不得依赖 window / document / process）
//
// 契约形状（v1）：
//   { "v": 1, "turn": 7, "content": [ {type:'say'|'script'|'ask'|'handoff', ...} ] }
// 派生语义（不由本文件决定，由调用方按块列表推导）：
//   有 ask 块 ⇒ 停循环等用户；有 script 块 ⇒ 执行后回灌；无执行块 ⇒ 本 turn 即总结；
//   有 handoff 块 ⇒ 轮转会话。
// [CONSTRAINT] 首版**不含 lane**：schema 只声明已实现的能力，不支持的东西必须报错而非静默丢弃。

/** 契约版本（写进 `v` 字段；缺省按 1 处理） */
export const TURN_SCHEMA_VERSION = 1

/** 已实现的块类型（注册表）。新增工具类型 = 往这里加一项 + 在 validateBlock 加一个分支 */
export const TURN_BLOCK_TYPES = ['say', 'script', 'ask', 'handoff', 'done']

/** script 块可接受的 lang（白名单，不做别名归一：别名会让「写错」变成「猜对了」） */
export const TURN_SCRIPT_LANGS = ['js', 'cjs']

/**
 * 找出所有候选 JSON 起点（每个 ```json 围栏内的第一个 `{`，以及整段以 `{` 开头的情形）。
 * [WHY] 不能用 ```…``` 正则截体：script.code 里一旦出现反引号围栏（脚本要输出 Markdown 时很常见），
 *   正则会提前闭合，把整条回复打成噪音卡。这里只定位起点，终点交给配平扫描。
 * @param text 原文
 * @returns 起点下标数组（升序）
 */
function findCandidates(text) {
  const out = []
  const re = /```[ \t]*json[ \t]*\r?\n[ \t]*\{/gi
  let m = re.exec(text)
  while (m) {
    out.push(m.index + m[0].length - 1)
    m = re.exec(text)
  }
  // [outside-text-tolerance-v2] 围栏外可能有说明文字（模型偶尔不守「围栏外零字符」）。
  //   [WHY] 原实现只认「整段以 `{` 开头」，否则无候选 ⇒ TURN_NOT_JSON ⇒ 整轮丢弃。
  //   [CONSTRAINT] 不能扫所有 `{`（v1 试过）：script.code 里的花括号会被当候选、配平出伪对象覆盖真信封。
  //   只放宽**起始位置**：跳过前导文字，从首个「```json 围栏」或「行首 `{`」开始解析。
  if (!out.length) {
    const atLine = text.search(/(^|\n)[ \t]*\{/)
    if (atLine >= 0) {
      const at = text.indexOf('{', atLine)
      if (at >= 0 && !out.includes(at)) out.push(at)
    }
  }
  return out
}

/**
 * 从 from 处的 `{` 起做**字符串感知**的花括号配平，返回对象结束后的下标（开区间）。
 * [CONSTRAINT] 必须跳过字符串内部的括号与 `\"` 转义，否则 `{"code":"} "}` 会提前闭合。
 * @param text 原文
 * @param from 起点（必为 `{`）
 * @returns 结束下标；未闭合返回 -1
 */
function scanObjectEnd(text, from) {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = from; i < text.length; i++) {
    const ch = text.charAt(i)
    if (inStr) {
      if (esc) { esc = false; continue }
      if (ch === '\\') { esc = true; continue }
      if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') { depth += 1; continue }
    if (ch === '}') {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return -1
}

/**
 * 在 content 数组内部逐个切出**已配平**的元素对象（流式安全的增量解析基础）。
 * [WHY] 整段信封闭合要等模型写完最后一笔；而脚本块一配平就该能开跑（等价 API 的
 *   content_block_start）。本函数只切元素，不做校验，校验交给 validateBlock。
 * @param text 原文
 * @returns 元素原文数组（可能不完整，末尾元素可能缺失）
 */
function sliceContentElements(text) {
  const out = []
  const at = text.search(/"content"\s*:\s*\[/)
  if (at < 0) return out
  let i = text.indexOf('[', at)
  if (i < 0) return out
  i += 1
  let depth = 0
  let inStr = false
  let esc = false
  let start = -1
  for (; i < text.length; i++) {
    const ch = text.charAt(i)
    if (inStr) {
      if (esc) { esc = false; continue }
      if (ch === '\\') { esc = true; continue }
      if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') {
      if (depth === 0) start = i
      depth += 1
      continue
    }
    if (ch === '}') {
      depth -= 1
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1))
        start = -1
      }
      continue
    }
    if (ch === ']' && depth === 0) break
  }
  return out
}

/**
 * 校验并归一化单个块。
 * [CONSTRAINT] 返回 `{ block, errors }`：block 为 null 表示该块不可用（errors 非空）。
 *   字段一律「有就收窄、没有就补默认值或报错」，绝不抛异常。
 * @param raw 原始元素
 * @param index 在 content 中的下标（用于错误定位）
 */
function validateBlock(raw, index) {
  const errors = []
  const at = `#${index + 1}`
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({ code: 'BLOCK_UNKNOWN_TYPE', block: at, field: 'type', detail: '块不是对象' })
    return { block: null, errors }
  }
  const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : ''
  if (!TURN_BLOCK_TYPES.includes(type)) {
    errors.push({ code: 'BLOCK_UNKNOWN_TYPE', block: at, field: 'type', detail: type || '（缺失）' })
    return { block: null, errors }
  }
  const rawId = typeof raw.id === 'string' ? raw.id.trim() : ''

  if (type === 'say') {
    const text = typeof raw.text === 'string' ? raw.text : ''
    if (!text.trim()) errors.push({ code: 'BLOCK_MISSING_FIELD', block: rawId || at, field: 'text' })
    return { block: { type: 'say', id: rawId || (`say_${index + 1}`), text }, errors }
  }

  if (type === 'handoff') {
    const summary = typeof raw.summary === 'string' ? raw.summary : (typeof raw.text === 'string' ? raw.text : '')
    if (!summary.trim()) errors.push({ code: 'BLOCK_MISSING_FIELD', block: rawId || at, field: 'summary' })
    return { block: { type: 'handoff', id: rawId || (`handoff_${index + 1}`), summary }, errors }
  }

  if (type === 'ask') {
    const question = typeof raw.question === 'string' ? raw.question : ''
    if (!rawId) errors.push({ code: 'BLOCK_MISSING_FIELD', block: at, field: 'id' })
    if (!question.trim()) errors.push({ code: 'BLOCK_MISSING_FIELD', block: rawId || at, field: 'question' })
    const rawOptions = Array.isArray(raw.options) ? raw.options : []
    const options = []
    for (let i = 0; i < rawOptions.length; i++) {
      const o = rawOptions[i]
      const label = o && typeof o === 'object' && typeof o.label === 'string' ? o.label : ''
      if (!label.trim()) continue
      const oid = o && typeof o.id === 'string' && o.id ? o.id : (`opt_${options.length + 1}`)
      options.push({ id: oid, label })
    }
    return { block: { type: 'ask', id: rawId || (`ask_${index + 1}`), question, options }, errors }
  }

  if (type === 'done') {
    const summary = typeof raw.summary === 'string' ? raw.summary : ''
    const commit = typeof raw.commit === 'string' ? raw.commit.trim() : ''
    if (!rawId) errors.push({ code: 'BLOCK_MISSING_FIELD', block: at, field: 'id' })
    if (!summary.trim()) errors.push({ code: 'BLOCK_MISSING_FIELD', block: rawId || at, field: 'summary' })
    if (commit && !/^(feat|fix|chore|refactor|docs|test|perf)(\([^)]+\))?: .{1,72}$/.test(commit)) {
      errors.push({ code: 'BLOCK_INVALID_FIELD', block: rawId || at, field: 'commit', detail: commit.slice(0, 80) })
    }
    return { block: { type: 'done', id: rawId || (`done_${index + 1}`), summary, ...(commit ? { commit } : {}) }, errors }
  }

  // type === 'script'
  const lang = typeof raw.lang === 'string' ? raw.lang.trim().toLowerCase() : ''
  const desc = typeof raw.desc === 'string' ? raw.desc : ''
  const why = typeof raw.why === 'string' ? raw.why : ''
  const code = typeof raw.code === 'string' ? raw.code : ''
  if (!rawId) errors.push({ code: 'BLOCK_MISSING_FIELD', block: at, field: 'id' })
  if (!lang) errors.push({ code: 'BLOCK_MISSING_FIELD', block: rawId || at, field: 'lang' })
  else if (!TURN_SCRIPT_LANGS.includes(lang)) errors.push({ code: 'BLOCK_BAD_LANG', block: rawId || at, field: 'lang', detail: lang })
  if (!desc.trim()) errors.push({ code: 'BLOCK_MISSING_FIELD', block: rawId || at, field: 'desc' })
  if (!why.trim()) errors.push({ code: 'BLOCK_MISSING_FIELD', block: rawId || at, field: 'why' })
  if (!code.trim()) errors.push({ code: 'BLOCK_MISSING_FIELD', block: rawId || at, field: 'code' })
  return {
    block: { type: 'script', id: rawId, lang, desc, why, code },
    errors,
  }
}

/**
 * 把已校验的块并入结果集，处理同 id 复用。
 * [D8] 未执行的块可以覆盖、已执行的块只能上报 —— 解析层无法知道执行状态，因此这里统一
 *   「后到覆盖先到」并把冲突记进 errors；是否重跑由执行器的 (turn,id) 账本决定。
 * @param acc 累积结果 { blocks, errors }
 * @param block 校验通过的块
 */
function mergeBlock(acc, block) {
  if (!block || !block.id) { acc.blocks.push(block); return }
  const idx = acc.blocks.findIndex((it) => { return it && it.id === block.id })
  if (idx < 0) { acc.blocks.push(block); return }
  const prev = acc.blocks[idx]
  if (JSON.stringify(prev) === JSON.stringify(block)) return
  acc.blocks[idx] = block
  acc.errors.push({ code: 'BLOCK_DUP_ID', block: block.id, field: 'id', detail: 'superseded' })
}

/**
 * 把 JSON **字符串字面量内部**的裸控制字符改写成合法转义，再交给 JSON.parse。
 *
 * [WHY] 模型写 script.code 时经常图省事，直接在 `"code": "..."` 里敲**真换行**（U+000A）
 *   而不是两字符的 `\n`。这不是排版问题而是转义问题：`JSON.parse` 对字符串字面量里的
 *   裸控制字符直接抛 `Bad control character in string literal`，整条信封解析不出对象
 *   ⇒ 油猴回落 plain 把 JSON 原文整坨推上屏、script 块零执行（用户实测 2026-10-19，
 *   对照组：同结构的单行/合法转义信封一切正常）。
 *   所以「能跑的」和「不能跑的」两份信封差异**不在块结构，只在 code 里换行的形态**。
 *
 * [CONSTRAINT] 必须字符串感知：只改字符串内部的控制字符，且跳过 `\"` 已消费的位置。
 *   否则代码里的引号会被误判成字符串边界，把结构字符（`{` `}` `,`）也转义掉，
 *   修好一个坏两个。
 * [CONSTRAINT] 只在 JSON.parse 已经失败时兜底调用（见 safeJsonParse），正常信封零开销、
 *   且严格 JSON 的行为完全不变（严格解析成功时压根不进这里）。
 * [CONSTRAINT] 幂等：已转义文本再过一次不产生变化（`\` 已消费 ⇒ 下一个字符不处理）。
 * @param text 待解析的 JSON 文本
 * @returns 修正后的 JSON 文本
 */
export function escapeControlCharsInStrings(text) {
  let out = ''
  let inStr = false
  let esc = false
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i)
    if (inStr) {
      if (esc) { out += ch; esc = false; continue }
      if (ch === '\\') { out += ch; esc = true; continue }
      if (ch === '"') { inStr = false; out += ch; continue }
      const code = text.charCodeAt(i)
      // JSON 规范：字符串字面量内只允许码位 ≥ 0x20，其余必须转义
      if (code < 0x20) {
        if (ch === '\n') out += '\\n'
        else if (ch === '\r') out += '\\r'
        else if (ch === '\t') out += '\\t'
        else if (ch === '\b') out += '\\b'
        else if (ch === '\f') out += '\\f'
        else out += `\\u${code.toString(16).padStart(4, '0')}`
        continue
      }
      out += ch
      continue
    }
    if (ch === '"') inStr = true
    out += ch
  }
  return out
}

/**
 * JSON.parse 的宽容包装：严格解析失败时，转义字符串内的裸控制字符再试一次。
 *
 * [WHY] 不直接无条件转义：严格 JSON 是契约基线，先严格试能保证「本来就能解析的输入
 *   走的是零改写的原路径」，宽容只作为**救 malformed 输出**的兜底，不放宽块结构校验
 *   （字段缺失 / 未知类型仍然照常报错，不会因为宽容而静默通过）。
 * @param text JSON 文本
 * @returns 解析结果；两次都失败抛错（由调用方按既有 try/catch 处理）
 */
export function safeJsonParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return JSON.parse(escapeControlCharsInStrings(text))
  }
}

/**
 * 解析一条完整的 turn 信封。
 * @param md 回复原文（Markdown 或裸 JSON 均可）
 * @returns {turn, blocks, truncated, errors}；解析不出对象时 errors 含
 *   TURN_TRUNCATED（未配平＝还在流式写入）或 TURN_NOT_JSON（配平了但不是对象）
 */
export function parseTurn(md) {
  const text = String(md ?? '')
  const out = { turn: null, blocks: [], truncated: false, errors: [] }
  if (!text) {
    out.errors.push({ code: 'TURN_NOT_JSON', detail: '空输入' })
    return out
  }
  const cands = findCandidates(text)
  if (!cands.length) {
    out.errors.push({ code: 'TURN_NOT_JSON', detail: '无 json 围栏且不以 { 开头' })
    return out
  }
  let obj = null
  for (let i = cands.length - 1; i >= 0; i--) {
    const end = scanObjectEnd(text, cands[i])
    if (end < 0) { out.truncated = true; continue }
    let parsed = null
    try { parsed = safeJsonParse(text.slice(cands[i], end)) } catch { continue }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    obj = parsed
    break
  }
  if (!obj) {
    // [CONSTRAINT] 两种「没解析出对象」必须区分开，否则模型拿到的修法是错的：
    //   · 围栏已开但对象还没配平 ⇒ 还在流式写入（TURN_TRUNCATED），等下一拍即可；
    //   · 围栏配平了但里面不是对象 ⇒ 真的写错了（TURN_NOT_JSON），必须改写。
    out.errors.push(out.truncated
      ? { code: 'TURN_TRUNCATED', detail: '围栏已开但对象未配平（流式未写完）' }
      : { code: 'TURN_NOT_JSON', detail: '围栏内不是可解析的对象' })
    return out
  }
  if (typeof obj.turn === 'number') out.turn = obj.turn
  const content = Array.isArray(obj.content) ? obj.content : null
  if (!content || content.length === 0) {
    out.errors.push({ code: 'TURN_NO_CONTENT', detail: '缺 content 或为空数组' })
    return out
  }
  for (let i = 0; i < content.length; i++) {
    const r = validateBlock(content[i], i)
    for (let k = 0; k < r.errors.length; k++) out.errors.push(r.errors[k])
    if (r.block) mergeBlock(out, r.block)
  }
  return out
}

/**
 * 增量解析：只返回**已配平**的 content 元素，不等整信封闭合。
 * [WHY] 流式下脚本块写完就该能开跑；等整段闭合会把多块 turn 的延迟叠加成 N 倍。
 * [CONSTRAINT] 不返回 truncated 判断 —— 是否「真的截断」由调用方的静默窗决定，
 *   解析层只负责「现在能确定什么」。
 * @param md 回复原文
 * @returns {turn, blocks, errors}：只含**已配平**元素的解析结果，未闭合部分不出块
 */
export function parseTurnPartial(md) {
  const text = String(md ?? '')
  const out = { turn: null, blocks: [], errors: [] }
  const turnMatch = text.match(/"turn"\s*:\s*(\d+)/)
  if (turnMatch) out.turn = Number(turnMatch[1])
  const elems = sliceContentElements(text)
  for (let i = 0; i < elems.length; i++) {
    let parsed = null
    try { parsed = safeJsonParse(elems[i]) } catch { continue }
    const r = validateBlock(parsed, i)
    for (let k = 0; k < r.errors.length; k++) out.errors.push(r.errors[k])
    if (r.block) mergeBlock(out, r.block)
  }
  return out
}
// <<< END turn-schema
