// @desc 单例「AI 提问 → 用户回答」弹窗状态 + Promise API
// @why 解耦 UI（AskDialog.vue）与调用方（reply-handlers）；Promise 化便于 await 用户回答后 sendFill
// @change-impact 状态单例：多调用共用同一弹窗；已有弹窗时新调用以 null 主动 resolve 旧 Promise（同 useToast.confirmDialog）

import { ref } from 'vue'
import type { AskPayload } from '../../utils/ask-parser'

/** 弹窗当前载荷；null 表示未展示 */
export interface AskState {
  question: string
  options: Array<{ id: string, label: string }>
  resolve: (answer: string | null) => void
}

const askState = ref<AskState | null>(null)

/**
 * 展示 @ask 弹窗并等待用户回答
 * [CONSTRAINT] 单例：已有弹窗时先以 null 主动 resolve 旧 Promise，避免调用方 await 挂死
 * @returns 用户提交的文本；取消/关闭返回 null
 */
export function askUser(payload: AskPayload): Promise<string | null> {
  return new Promise((resolve) => {
    if (askState.value) askState.value.resolve(null)
    askState.value = {
      question: payload.question,
      options: payload.options,
      resolve,
    }
  })
}

/** 关闭弹窗并回传用户回答；[CONSTRAINT] 与 askUser 成对使用，弹窗未开时静默 */
export function resolveAsk(answer: string | null): void {
  const s = askState.value
  if (!s) return
  askState.value = null
  s.resolve(answer)
}

/** useAsk 组合式入口；直接透传模块级单例 */
export function useAsk() {
  return { askState, askUser, resolveAsk }
}
