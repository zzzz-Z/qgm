// [timeline-build-v1] 从 TerminalPane 抽出：busEvents → 卡片列表的纯函数。
// [WHY] 原实现是组件内 computed，任一事件到达即整条重算 500 条。
//   抽成纯函数后，可被「增量维护」按事件级缓存复用，也可被 vitest 直测。

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
export interface DividerItem { type: 'round-divider', key: string, roundLabel: string, timeLabel: string }
export type CardItem = ScriptItem | TextItem | DoneItem | AskItem | QuestionItem | DividerItem

export const PHASE_LABEL: Record<string, string> = {
  pending: '等待执行',
  running: '执行中',
  done: '已完成',
  error: '失败',
}
export const TEXT_PREVIEW = { lines: 12, chars: 800 }
export const ASK_PREVIEW = { lines: 6, chars: 400 }
export const DONE_PREVIEW = { lines: 30, chars: 3000 }
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
 * [CONSTRAINT] 返回值不含 round-divider（分隔条依赖前序状态，由 buildCards 层插入）。
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
  const outTail = tailTextPreview(String(p.stdoutTail || ''), TAIL_KEEP_LINES, TAIL_MAX_CHARS)
  const errTail = tailTextPreview(String(p.stderrTail || ''), TAIL_KEEP_LINES, TAIL_MAX_CHARS)
  return {
    type: 'script',
    key,
    langLabel,
    phaseLabel: PHASE_LABEL[phase] || phase,
    phaseClass: `phase-${phase}`,
    desc,
    timeLabel,
    exit: typeof p.exit === 'number' ? p.exit : null,
    changeCount: Number(p.changeCount || 0),
    stdoutText: outTail.text,
    stdoutHidden: outTail.hiddenLines,
    stderrText: errTail.text,
    stderrHidden: errTail.hiddenLines,
    why,
  }
}

/**
 * 事件数组 → 卡片列表；利用 updateKey 与事件 id 做增量缓存。
 * [WHY] 500 事件下任一事件到达时，原 computed 会整条重算；改成：
 *   ① 每个事件 id 对应一个卡片实例，缓存于 Map；
 *   ② 只有「事件引用变化」（同 id 不同对象）或「新事件」才重算；
 *   ③ round-divider 由前序状态决定，单独按位置插入，每次全量重建（极少，成本可忽略）。
 * [CONSTRAINT] 缓存 key = 事件 id；同 id 不同 payload 意味着事件被 updateKey 原地更新。
 * [CHANGE-IMPACT] TerminalPane 的 timelineItems 改调本函数；cache 由调用方持有（避免模块级状态）。
 */
export function buildCards(
  events: Array<{ id: number, kind: string, ts: number, payload?: Record<string, unknown> }>,
  cache: Map<number, { ref: object, card: ScriptItem | TextItem | DoneItem | AskItem | QuestionItem | null }>,
): CardItem[] {
  const out: CardItem[] = []
  let lastRound = 0
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
    if (card.type === 'script') {
      const loopRoundNum = Number(((ev.payload || {}) as Record<string, unknown>).loopRound || 0)
      if (loopRoundNum > 0 && loopRoundNum !== lastRound) {
        lastRound = loopRoundNum
        out.push({ type: 'round-divider', key: `rd-${loopRoundNum}-${ev.id}`, roundLabel: `R${loopRoundNum}`, timeLabel: card.timeLabel })
      }
      lastScriptCard = card
    }
    out.push(card)
  }
  void lastScriptCard
  // 清理已在 events 中消失的缓存条目
  const alive = new Set(events.map(e => e.id))
  for (const k of cache.keys()) { if (!alive.has(k)) cache.delete(k)
  }
  return out
}
