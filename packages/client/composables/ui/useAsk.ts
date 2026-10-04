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

/** useAsk 组合式入口；直接透传模块级单例 */
export function useAsk() {
  return { askState, askUser, resolveAsk }
}
