// [turn-block-frame-v1] 块列表 → 线上帧的纯映射。**不接线**：attach-ws 在 P4-b 才调用它。
//
// 为什么单独成文件而不是塞进 attach-ws：
//   ① attach-ws 里全是 ws / 会话 / 日志副作用，任何断言都得先造一个假连接；
//      这里是纯函数，一个数组进、一个对象出，优先级与字段收窄可以被逐条钉死。
//   ② 「等什么」这件事三处都要用（服务端发帧 / 前端继续循环 / 油猴同构），
//      派生规则必须只有一份，否则必然漂移 —— 与 turn-schema 同一个理由。
//
// [CONSTRAINT] 本文件不 import 运行时代码，只用 protocol 的类型；不读时间、不读全局，
//   同输入同输出（否则「这一帧该不该发」会被时钟与随机 id 污染，测试无法复现）。

import type { AiBlockDto, AiBlockType, AiTurnEndDto, ServerMessage } from '../server/protocol.js'

/** 解析器产出的块（结构上与 turn-schema.ts 的返回值一致，这里只声明用得到的字段） */
export interface RawBlock {
  type: string
  id: string
  text?: string
  code?: string
  lang?: string
  desc?: string
  why?: string
  question?: string
  options?: readonly { id?: string, label?: string }[]
  summary?: string
  commit?: string
}

/** 映射结果：帧数组 + 结束帧（两者一起发，故一起返回） */
export interface TurnFrames {
  blocks: AiBlockDto[]
  end: AiTurnEndDto
}

const SCRIPT_LANGS: readonly string[] = ['js', 'cjs']

/**
 * 派生「这一轮结束后循环等什么」。
 *
 * 优先级 **script > ask > none**：
 * - 有 script ⇒ `results`：执行结果必须回灌，否则下一轮没东西可推理；
 *   同一 turn 里的 ask 卡在块到达时就已渲染（P6 按 seq 占位），用户随时可答，不需要循环为它暂停。
 * - 无 script 且有 ask ⇒ `user`：没有可执行的东西，停在这里等用户选。
 * - 都没有 ⇒ `none`：本 turn 即总结（`DONE` 概念消失）。
 *
 * [WHY] 不让前端各自推导：三处推导必然在「既有 script 又有 ask」这种组合上分叉，
 *   而分叉的后果是**循环要么空转要么提前结束**，且没有任何一处报错。
 */
export function deriveAwaiting(blocks: readonly AiBlockDto[]): AiTurnEndDto['awaiting'] {
  let hasScript = false
  let hasAsk = false
  for (const b of blocks) {
    if (b.type === 'script') hasScript = true
    else if (b.type === 'ask') hasAsk = true
  }
  if (hasScript) return 'results'
  if (hasAsk) return 'user'
  return 'none'
}

/**
 * [turn-mode-v1] 本轮性质的显式标记，与 `deriveAwaiting` 同源但语义更明确：
 * `awaiting === 'none'` 就是总结轮，`mode` 把这个推断**固化成字段**，
 * 让消费方不必各自重写「无 script 且无 ask ⇒ 总结」这条规则。
 */
export function deriveTurnMode(blocks: readonly AiBlockDto[]): 'summary' | 'results' | 'user' {
  const awaiting = deriveAwaiting(blocks)
  return awaiting === 'none' ? 'summary' : awaiting
}

/** 是否有 handoff 块（轮转会话）。与 awaiting 正交：轮转与「等结果/等用户」可以同时成立 */
export function deriveRotate(blocks: readonly AiBlockDto[]): boolean {
  return blocks.some(b => b.type === 'handoff')
}

/**
 * 把一个 turn 的块列表映射成块帧 + 结束帧。
 *
 * [CONSTRAINT] `seq` 取**输入数组下标**而非「已发块计数」：
 *   被跳过的块会在 seq 上留出空洞，前端据此能发现「说好的第 3 块没来」，
 *   而不是把第 4 块错位当成第 3 块渲染。
 * [CONSTRAINT] 未知/不合法的块进 `skipped`（`<id>:<reason>`），不抛异常也不静默丢弃：
 *   解析器已经做过一次校验，这里再挡一次是防「别的调用方直接构造 RawBlock」。
 */
export function blocksToFrames(turnId: number, raw: readonly RawBlock[]): TurnFrames {
  const blocks: AiBlockDto[] = []
  const skipped: string[] = []

  for (let i = 0; i < raw.length; i++) {
    const b = raw[i]
    const id = b && typeof b.id === 'string' ? b.id : `#${i + 1}`
    const type = b && typeof b.type === 'string' ? b.type : ''
    if (!isBlockType(type)) {
      skipped.push(`${id}:type`)
      continue
    }
    const frame = toFrame(turnId, id, i, type, b)
    if (typeof frame === 'string') {
      skipped.push(`${id}:${frame}`)
      continue
    }
    blocks.push(frame)
  }

  const end: AiTurnEndDto = { turnId, awaiting: deriveAwaiting(blocks), mode: deriveTurnMode(blocks), blocks: blocks.length }
  if (skipped.length > 0) end.skipped = skipped
  return { blocks, end }
}

function isBlockType(t: string): t is AiBlockType {
  return t === 'say' || t === 'script' || t === 'ask' || t === 'handoff' || t === 'done'
}

/**
 * 把一个 turn 直接映射成**要发出去的帧序列**（块帧按 seq 顺序 + 末尾一个结束帧）。
 *
 * [WHY] 发帧顺序是契约的一部分（前端按 `seq` 占位、结束帧必须最后到），
 *   放进纯函数才能断言「顺序」而不必起一个 WS。
 * [CONSTRAINT] 空 turn（没有任何可用块）返回空数组，**不发结束帧**：
 *   一个 `blocks: 0` 的 turn-end 会让前端新建一个空 turn 占位并等它，比什么都不发更糟。
 */
export function turnToFrames(sid: string, turnId: number, raw: readonly RawBlock[]): ServerMessage[] {
  const { blocks, end } = blocksToFrames(turnId, raw)
  if (blocks.length === 0) return []
  const out: ServerMessage[] = []
  for (const b of blocks) out.push({ t: 'ai:block', sid, block: b })
  out.push({ t: 'ai:turn-end', sid, end })
  return out
}

/**
 * 单块收窄。返回字符串表示「为什么跳过」（缺什么字段），返回对象表示可用。
 * [WHY] 只输出该类型**该有**的字段：把 `code` 塞进 say 帧会让前端有机会读错字段，
 *   也让「字段贯通」类断言（P6 采信守卫）失去意义。
 */
function toFrame(turnId: number, blockId: string, seq: number, type: AiBlockType, b: RawBlock): AiBlockDto | string {
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
    const options: { id: string, label: string }[] = []
    const rawOptions = Array.isArray(b.options) ? b.options : []
    for (const o of rawOptions) {
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
    return { turnId, blockId, seq, type, summary, ...(commit ? { commit } : {}) } as AiBlockDto
  }
  // script
  const lang = typeof b.lang === 'string' ? b.lang : ''
  const code = typeof b.code === 'string' ? b.code : ''
  const desc = typeof b.desc === 'string' ? b.desc : ''
  const why = typeof b.why === 'string' ? b.why : ''
  if (!code.trim()) return 'code'
  if (!SCRIPT_LANGS.includes(lang)) return 'lang'
  if (!desc.trim()) return 'desc'
  if (!why.trim()) return 'why'
  return { turnId, blockId, seq, type, lang: lang as 'js' | 'cjs', desc, why, code }
}
