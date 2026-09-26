import { ref } from 'vue'
import type { Ref } from 'vue'
import { LS_CMD_HISTORY_KEY } from '../../utils/storage'

/**
 * 命令历史：从 localStorage 加载 / 追加 / 上下翻
 * [cmd-history-v1] 从 ScriptPanel.vue 抽离的独立模块
 */

const CMD_HISTORY_KEY = LS_CMD_HISTORY_KEY
const CMD_HISTORY_MAX = 100

function loadCmdHistory(): string[] {
  try {
    const raw = localStorage.getItem(CMD_HISTORY_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

export interface CmdHistoryApi {
  cmdHistory: Ref<string[]>
  pushCmdHistory: (cmd: string) => void
  cmdHistoryPrev: () => void
  cmdHistoryNext: () => void
}

export function createCmdHistory(deps: { script: Ref<string> }): CmdHistoryApi {
  const { script } = deps
  const cmdHistory = ref<string[]>(loadCmdHistory())
  let cmdHistoryIndex = -1
  let cmdHistoryDraft = ''

  function pushCmdHistory(cmd: string) {
    const arr = cmdHistory.value.filter(c => c !== cmd)
    arr.unshift(cmd)
    cmdHistory.value = arr.slice(0, CMD_HISTORY_MAX)
    try {
      localStorage.setItem(CMD_HISTORY_KEY, JSON.stringify(cmdHistory.value))
    } catch {
      // localStorage 可能被禁用，静默降级（不阻塞命令历史功能）
    }
    cmdHistoryIndex = -1
    cmdHistoryDraft = ''
  }

  function cmdHistoryPrev() {
    if (!cmdHistory.value.length) return
    if (cmdHistoryIndex === -1) cmdHistoryDraft = script.value
    cmdHistoryIndex = Math.min(cmdHistoryIndex + 1, cmdHistory.value.length - 1)
    script.value = cmdHistory.value[cmdHistoryIndex]
  }

  function cmdHistoryNext() {
    if (cmdHistoryIndex === -1) return
    cmdHistoryIndex--
    if (cmdHistoryIndex < 0) script.value = cmdHistoryDraft
    else script.value = cmdHistory.value[cmdHistoryIndex]
  }

  return { cmdHistory, pushCmdHistory, cmdHistoryPrev, cmdHistoryNext }
}
