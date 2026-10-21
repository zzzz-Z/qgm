// [timeline-build-v1] 从 TerminalPane 抽出：busEvents → 卡片列表的纯函数。
// [WHY] 原实现是组件内 computed，任一事件到达即整条重算 500 条。
//   抽成纯函数后，可被「增量维护」按事件级缓存复用，也可被 vitest 直测。
//
// [explicit-import-v1] 这两个函数原先靠 unplugin-auto-import 的全局注入（vite 侧 dirs: ['utils/**']）。
// [WHY 改成显式 import] vitest.config.ts **没有挂 AutoImport 插件** ⇒ 在测试里它们是 ReferenceError，
//   于是本模块此前**根本没有任何用例**（想测也起不来）。显式 import 对 vite 完全无害
//   （已显式导入的符号插件不会重复注入），代价是两行，收益是「这个模块终于可被断言」。
import { clampTextPreview, denoiseLog, tailTextPreview, unfoldEscapedLog } from './timeline-preview.js'

export interface PreviewFields {
  text: string
  preview: string
  truncated: boolean
  hiddenLines: number
  totalLines: number
}
export interface ScriptItem {
  type: 'script'
  key: string
  langLabel: string
  phaseLabel: string
  phaseClass: string
  desc: string
  timeLabel: string
  exit: number | null
  changeCount: number
  stdoutText: string
  stdoutHidden: number
  stderrText: string
  stderrHidden: number
  why: string
  // [script-card-reason-v1] 失败原因（payload.reason）；须与 TerminalPane 的活构建路径同构，
  //   否则将来把卡构建切回本函数时 reason 会静默丢失。
  reason: string
  // [card-duration-v1] 本轮执行耗时（ms）；须与 TerminalPane 活构建路径同构
  durationMs: number | null
  // [script-card-changes-v1] 本次执行产生的变更文件（path + type）；空数组=无改动
  changes: Array<{ path: string, type: string }>
}
export interface TextItem extends PreviewFields { type: 'text', key: string, timeLabel: string }
export interface DoneItem extends PreviewFields { type: 'done', key: string, timeLabel: string }
export interface AskItem extends PreviewFields { type: 'ask', key: string, timeLabel: string, role?: 'user-answer' }
export interface QuestionItem extends PreviewFields {
  type: 'question'
  key: string
  timeLabel: string
  askId: string
  options: Array<{ id: string, label: string }>
  answered: boolean
  answer: string
}
export type CardItem = ScriptItem | TextItem | DoneItem | AskItem | QuestionItem

export const PHASE_LABEL: Record<string, string> = {
  pending: '等待执行',
  running: '执行中',
  done: '已完成',
  error: '失败',
}
export const TEXT_PREVIEW = { lines: 12, chars: 800 }
export const ASK_PREVIEW = { lines: 6, chars: 400 }
// [done-preview-widen-v1] DONE 总结是最终交付物：实测 60-100 行（变更表 + 验证 + 踩坑 + 遗留），
//   原 30 行阈值导致「总结面板显示不全」——用户看不到后半段。提到 80 行 + 8000 字符。
export const DONE_PREVIEW = { lines: 80, chars: 8000 }
export const TAIL_KEEP_LINES = 5
export const TAIL_MAX_CHARS = 400
export const PHASE_DONE_CLASS = 'phase-done'
export const PHASE_ERROR_CLASS = 'phase-error'

export function hmsLabel(ts?: number): string {
  const d = new Date(ts || Date.now())
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function normalizeAskOptions(raw: unknown): Array<{ id: string, label: string }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ id: string, label: string }> = []
  for (const item of raw) {
    const o = (item || {}) as Record<string, unknown>
    const label = String(o.label ?? '').trim()
    if (!label) continue
    out.push({ id: String(o.id || `opt_${out.length + 1}`), label })
  }
  return out
}

/**
 * 单个事件 → 卡片或 null。
 * [WHY] 增量维护的关键：每个事件按 id 缓存结果，只有该事件变化时才重算。
 * [CHANGE-IMPACT] 被 TerminalPane 的 timelineItems 增量维护消费。
 */
export function buildOneCard(ev: { id: number, kind: string, ts: number, payload?: Record<string, unknown> }):
  ScriptItem | TextItem | DoneItem | AskItem | QuestionItem | null {
  if (ev.kind === 'ai:question') {
    const tp = (ev.payload || {}) as Record<string, unknown>
    const question = String(tp.question || '').trim()
    const options = normalizeAskOptions(tp.options)
    if (!question && options.length === 0) return null
    const pv = clampTextPreview(question, ASK_PREVIEW.lines, ASK_PREVIEW.chars)
    return {
      type: 'question',
      key: `question-${ev.id}`,
      timeLabel: hmsLabel(Number(tp.askedAt) || ev.ts),
      askId: String(tp.askId || ''),
      options,
      answered: tp.answered === true,
      answer: String(tp.answer || ''),
      text: question,
      ...pv,
    }
  }
  if (ev.kind === 'ai:ask') {
    const tp = (ev.payload || {}) as Record<string, unknown>
    const text = String(tp.text || '').trim()
    if (!text) return null
    const pv = clampTextPreview(text, ASK_PREVIEW.lines, ASK_PREVIEW.chars)
    return {
      type: 'ask',
      key: `ask-${ev.id}`,
      timeLabel: hmsLabel(ev.ts),
      text,
      ...pv,
      ...(tp.role === 'user-answer' ? { role: 'user-answer' as const } : {}),
    }
  }
  if (ev.kind === 'ai:done') {
    const tp = (ev.payload || {}) as Record<string, unknown>
    const text = String(tp.text || '').trim()
    if (!text) return null
    const pv = clampTextPreview(text, DONE_PREVIEW.lines, DONE_PREVIEW.chars)
    return { type: 'done', key: `done-${ev.id}`, timeLabel: hmsLabel(ev.ts), text, ...pv }
  }
  if (ev.kind === 'ai:plain' || ev.kind === 'ai:multi') {
    const tp = (ev.payload || {}) as Record<string, unknown>
    const text = String(tp.text || '').trim()
    if (!text) return null
    const pv = clampTextPreview(text, TEXT_PREVIEW.lines, TEXT_PREVIEW.chars)
    return { type: 'text', key: `text-${ev.id}`, timeLabel: hmsLabel(ev.ts), text, ...pv }
  }
  // [turn-block-frame-v1] 块帧：一个块一帧，按 seq 顺序到达 ⇒ 时间线顺序天然等于 content 顺序，
  //   不再需要从一段 Markdown 里反推「哪句话配哪个脚本」。
  //
  // [WHY script 块不建卡] 块里没有执行数据（exit / 时长 / stdout / changes 全在 run:* 事件里）。
  //   若在此建一张「等待执行」占位卡，等 run:start 再建一张真卡，用户会看到两张同 desc 的卡；
  //   要对上就必须让占位 key 与 runner 的 updateKey 完全一致 —— 那是跨模块隐式耦合，
  //   而**代价换来的只是顺序**。故 script 块显式返回 null，由 run:start 建卡（见风险 R8）。
  // [CONSTRAINT] `say` 与 `handoff` 都渲染为文本卡：handoff 的载荷是交班摘要，
  //   用户需要读到它才能知道「为什么换会话了」，吞掉它等于把轮转变成静默行为。
  if (ev.kind === 'ai:block') {
    const tp = (ev.payload || {}) as Record<string, unknown>
    const b = (tp as { block?: Record<string, unknown> }).block
    if (!b) return null
    const blockId = String(b.blockId || '')
    const turnId = Number(b.turnId) || 0
    if (b.type === 'say' || b.type === 'handoff') {
      const text = String(b.type === 'say' ? b.text || '' : b.summary || '').trim()
      if (!text) return null
      const pv = clampTextPreview(text, TEXT_PREVIEW.lines, TEXT_PREVIEW.chars)
      return { type: 'text', key: `blk-${turnId}-${blockId}`, timeLabel: hmsLabel(ev.ts), text, ...pv }
    }
    if (b.type === 'ask') {
      const question = String(b.question || '').trim()
      const options = normalizeAskOptions(b.options)
      if (!question && options.length === 0) return null
      const pv = clampTextPreview(question, ASK_PREVIEW.lines, ASK_PREVIEW.chars)
      // [turn-ask-options-v1] options 直接来自块，**不再解析文本**（旧路径 parseAsk 猜选项）。
      //   askId 用块 id：回答事件按 askId 回填 answered/answer，与 ai:question 同一套匹配规则。
      // [ask-single-card-v1] answered/answer 读**事件顶层**：回答更新打在这条事件的 updateKey 上，
      //   合并后与 block 同处 payload；写死 false 会让块帧提问卡答完仍可点（原缺陷）。
      return {
        type: 'question',
        key: `blk-${turnId}-${blockId}`,
        timeLabel: hmsLabel(ev.ts),
        askId: blockId,
        options,
        answered: tp.answered === true,
        answer: String(tp.answer || ''),
        text: question,
        ...pv,
      }
    }
    return null
  }
  if (ev.kind !== 'run:start') return null
  const p = (ev.payload || {}) as Record<string, unknown>
  const desc = String(p.desc || '').trim()
  const why = String(p.why || '').trim()
  const lang = String(p.lang || 'js')
  const phase = String(p.phase || 'running')
  const key = String(p.updateKey || `ev-${ev.id}`)
  if (!why && (!desc || desc === '执行脚本')) return null
  const langLabel = lang === 'bash' ? 'BASH' : lang === 'cjs' ? 'CJS' : 'JS'
  const timeLabel = hmsLabel(ev.ts)
  // [log-unfold-v1] 先展开 JSON 转义串（字面量 \n / \u001b），再降噪折叠——
  //   否则「被 stringify 过的输出」行数恒为 1 且转义码原样上屏（与 TerminalPane 活构建路径同构）
  const outTail = tailTextPreview(denoiseLog(unfoldEscapedLog(String(p.stdoutTail || ''))), TAIL_KEEP_LINES, TAIL_MAX_CHARS)
  const errTail = tailTextPreview(denoiseLog(unfoldEscapedLog(String(p.stderrTail || ''))), TAIL_KEEP_LINES, TAIL_MAX_CHARS)
  return {
    type: 'script',
    key,
    langLabel,
    phaseLabel: PHASE_LABEL[phase] || phase,
    phaseClass: `phase-${phase}`,
    desc,
    timeLabel,
    exit: typeof p.exit === 'number' ? p.exit : null,
    durationMs: typeof p.durationMs === 'number' ? p.durationMs : null,
    changeCount: Number(p.changeCount || 0),
    stdoutText: outTail.text,
    stdoutHidden: outTail.hiddenLines,
    stderrText: errTail.text,
    stderrHidden: errTail.hiddenLines,
    why,
    reason: String(p.reason || '').trim(),
    // [script-card-changes-v1] 本次执行变更文件；空数组=无改动
    changes: Array.isArray(p.changes) ? (p.changes as Array<{ path: string, type: string }>) : [],
  }
}

/**
 * 事件数组 → 卡片列表；利用 updateKey 与事件 id 做增量缓存。
 * [WHY] 500 事件下任一事件到达时，原 computed 会整条重算；改成：
 *   ① 每个事件 id 对应一个卡片实例，缓存于 Map；
 *   ② 只有「事件引用变化」（同 id 不同对象）或「新事件」才重算；
 * [CONSTRAINT] 缓存 key = 事件 id；同 id 不同 payload 意味着事件被 updateKey 原地更新。
 * [CHANGE-IMPACT] TerminalPane 的 timelineItems 改调本函数；cache 由调用方持有（避免模块级状态）。
 */
export function buildCards(
  events: Array<{ id: number, kind: string, ts: number, payload?: Record<string, unknown> }>,
  cache: Map<number, { ref: object, card: ScriptItem | TextItem | DoneItem | AskItem | QuestionItem | null }>,
): CardItem[] {
  const out: CardItem[] = []
  const lastRound = 0
  let lastScriptCard: ScriptItem | null = null
  for (const ev of events) {
    const cached = cache.get(ev.id)
    let card: ScriptItem | TextItem | DoneItem | AskItem | QuestionItem | null
    if (cached && cached.ref === ev) {
      card = cached.card
    } else {
      card = buildOneCard(ev)
      cache.set(ev.id, { ref: ev, card })
    }
    if (!card) continue
    if (card.type === 'script') lastScriptCard = card
    out.push(card)
  }
  void lastScriptCard
  // 清理已在 events 中消失的缓存条目
  const alive = new Set(events.map(e => e.id))
  for (const k of cache.keys()) { if (!alive.has(k)) cache.delete(k)
  }
  return out
}
