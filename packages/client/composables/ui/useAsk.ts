import { ref } from 'vue'
// @desc 「AI 提问 → 用户回答」的状态单例 + Promise API
// @why 解耦 UI（TerminalPane 的提问卡）与调用方（reply-handlers / useAiReplyHandlers）；
//      Promise 化便于 await 用户回答后 sendFill
// [ask-card-v1] 不再弹窗：提问直接写进事件流（kind='ai:question'），由 TerminalPane 渲染成
//      对话流里的可点选卡片。好处有三：① 提问留在时间线上（可持久化 / 刷新后仍在）；
//      ② 不再阻塞整个界面；③ 选项与自由输入在同一张卡上，用户能看见自己答了什么
// @change-impact 状态仍为单例：多调用共用同一张卡；已有提问时新调用以 null 主动 resolve 旧 Promise

import type { AskPayload } from '../../utils/ask-parser'
import { emit } from './useEventStream'

/** 提问卡当前载荷；null 表示无活跃提问 */
export interface AskState {
  /** 本次提问 id；与事件流 updateKey 一一对应，UI 据此判断卡片是否仍可交互 */
  id: string
  question: string
  options: Array<{ id: string, label: string }>
  resolve: (answer: string | null) => void
}

/** [CONSTRAINT] 与 TerminalPane 的读取端、resolveAsk 的写回端三处共用，改名会失去原地更新能力 */
const ASK_KEY_PREFIX = 'askq-'
let askSeq = 0

const askState = ref<AskState | null>(null)

/**
 * 在对话流里投递一张 AI 提问卡，并等待用户回答
 * [CONSTRAINT] 单例：已有提问时先以 null 主动 resolve 旧 Promise，避免调用方 await 挂死
 * @param payload parseAsk 的解析结果
 * @returns 用户提交的文本；提问被取代/取消返回 null
 */
export function askUser(payload: AskPayload): Promise<string | null> {
  return new Promise((resolve) => {
    if (askState.value) askState.value.resolve(null)
    const id = `a${++askSeq}`
    askState.value = {
      id,
      question: payload.question,
      options: payload.options,
      resolve,
    }
    emit('ai:question', summarize(payload.question), {
      updateKey: `${ASK_KEY_PREFIX}${id}`,
      payload: {
        askId: id,
        question: payload.question,
        options: payload.options,
        askedAt: Date.now(),
        answered: false,
      },
    })
  })
}

/**
 * 关闭提问卡并回传用户回答
 * [CONSTRAINT] 与 askUser 成对使用；无活跃提问时静默（重复点击 / 旧卡片点击都不会重复投递）
 * [CHANGE-IMPACT] 回答写回同一条事件（updateKey 原地更新），使卡片转为「已回答」态并禁用按钮
 * @param answer 用户回答；null 表示取消 / 作废
 */
/**
 * [ask-restore-v1] 刷新后恢复提问卡的可交互态。
 * [WHY] askState 是内存 ref，刷新即丢；原实现据此把所有历史未回答的提问判为「已失效」，
 *   用户再也点不了选项（实测截图三个选项全灰）。「未被回答」与「被新提问取代」必须区分：
 *   前者应可恢复，后者才失效。判据交给调用方（卡片未 answered 且当前无活跃提问）。
 * @returns 是否成功建立活跃提问（已有活跃提问时返回 false，不抢占）
 */
export function restoreAsk(id: string, question: string, options: Array<{ id: string, label: string }>): boolean {
  // [ask-restore-v2] 抢占式重建：已有活跃提问时先 resolve(null) 释放，再重建。
  //   [WHY] 原实现 `if (askState.value) return false` 在用户点第二张卡片时直接失败——
  //   表现为「选项点击无反应」（实测）。点哪张卡片，哪张就该成为活跃提问。
  if (askState.value) askState.value.resolve(null)
  let resolveFn: (v: string | null) => void = () => {}
  const _p = new Promise<string | null>((r) => { resolveFn = r })
  void _p
  askState.value = { id, question, options, resolve: resolveFn }
  return true
}
export function resolveAsk(answer: string | null): void {
  const s = askState.value
  if (!s) return
  askState.value = null
  emit('ai:question', summarize(s.question), {
    updateKey: `${ASK_KEY_PREFIX}${s.id}`,
    payload: {
      answered: true,
      canceled: answer === null,
      answer: answer === null ? '' : String(answer),
      answeredAt: Date.now(),
    },
  })
  s.resolve(answer)
}

/**
 * 提问正文 → 事件卡列表上的一行摘要
 * [WHY] 事件流 summary 只用于折叠视图 / 日志，长正文没有价值
 * @param q 提问正文（Markdown）
 */
function summarize(q: string): string {
  const t = String(q || '').replace(/\s+/g, ' ').trim()
  return t ? `AI 提问 · ${t.slice(0, 40)}` : 'AI 提问'
}

/**
 * [ask-answer-key-v2] 按**卡片 askId**（turn 块 id）回填回答。
 * [WHY] askUser 的活跃提问 id 是 a1/a2 自增序号，与卡片 updateKey（askq-<blockId>）不是同一套；
 *   若沿用 resolveAsk，回答事件匹配不到卡片，界面永远不转「已回答」（用户实测点了没反应）。
 * [CONSTRAINT] 若当前活跃提问就是这张卡，一并兑现其 Promise，通知 await 方。
 */
export function answerAsk(askId: string, answer: string): void {
  const id = String(askId || '')
  if (!id) return
  const s = askState.value
  // [ask-answer-resolve-any-v1] 用户回答了任意一张 ask 卡，都应兑现 askUser 的 Promise：
  //   活跃提问 id 是 a1/a2 自增序号，卡片 askId 是 turn 块 id（如 q1），两者不等 ⇒
  //   原判据 s.id === id 恒假，Promise 永不 resolve，回答永远发不出去（用户实测点了没反应）。
  if (s) askState.value = null
  emit('ai:question', 'AI 提问', {
    updateKey: `${ASK_KEY_PREFIX}${id}`,
    payload: {
      answered: true,
      canceled: false,
      answer: String(answer),
      answeredAt: Date.now(),
    },
  })
  // [ask-answer-resolve-any-v1] 活跃提问 id（a1/a2）与卡片 askId（turn 块 id）不同套，
  //   按 id 相等判据恒假 ⇒ Promise 永不兑现、回答永不发送。用户回答了任一张卡都应 resolve。
  if (s) s.resolve(answer)
}

/** useAsk 组合式入口；直接透传模块级单例 */
export function useAsk() {
  return { askState, askUser, resolveAsk, restoreAsk, answerAsk }
}
