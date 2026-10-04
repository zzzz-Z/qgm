import type { Ref } from 'vue'

/**
 * 命令历史：从 localStorage 加载 / 追加 / 上下翻
 * [cmd-history-v1] 从 ScriptPanel.vue 抽离的独立模块
 */

export interface CmdHistoryApi {
  cmdHistory: Ref<string[]>
  pushCmdHistory: (cmd: string) => void
  cmdHistoryPrev: () => void
  cmdHistoryNext: () => void
}

const CMD_HISTORY_KEY = LS_CMD_HISTORY_KEY
const CMD_HISTORY_MAX = 100

/**
 * 数组 serializer：坏数据（非数组 / 解析失败）回退到空数组
 * [WHY] useLocalStorage 默认 JSON.parse 后不做形状校验；历史键若被污染（存成对象）会破坏 .length 等数组语义
 * [CONSTRAINT] read 必须永不抛错（隐私模式 / 坏 JSON 都不能阻断初始化）；write 保序输出
 */
const ARR_SERIALIZER = {
  read: (v: string): string[] => {
    try { const arr = JSON.parse(v); return Array.isArray(arr) ? arr : [] } catch { return [] }
  },
  write: (v: string[]): string => JSON.stringify(v),
}

export function createCmdHistory(deps: { script: Ref<string> }): CmdHistoryApi {
  const { script } = deps
  // [use-storage-v1] useLocalStorage 替代手写 load + setItem：自动序列化落盘 + 跨标签页 storage 事件同步
  // [CONSTRAINT] 须在 setup scope 内调用（内部 onScopeDispose 注册清理）；ScriptPanel 的 <script setup> 满足
  const cmdHistory = useLocalStorage<string[]>(CMD_HISTORY_KEY, [], { serializer: ARR_SERIALIZER })
  let cmdHistoryIndex = -1
  let cmdHistoryDraft = ''

  function pushCmdHistory(cmd: string) {
    const arr = cmdHistory.value.filter(c => c !== cmd)
    arr.unshift(cmd)
    // [use-storage-v1] 赋值即持久化：useLocalStorage 的 ref 写入自动触发序列化落盘，无需手动 setItem
    cmdHistory.value = arr.slice(0, CMD_HISTORY_MAX)
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
