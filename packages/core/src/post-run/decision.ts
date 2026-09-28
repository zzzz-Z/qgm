// 协议标记解析（helpers.cjs 单行 JSON）

/** 决策点选项：唯一标识、展示标签、补充说明 */
export interface DecisionOption { id: string, label: string }
/** 决策载荷：问题文本、候选选项、默认选中项 */
export interface DecisionPayload {
  question: string
  options: DecisionOption[]
  default?: string
}

/** 决策标记集合：__AI_RUNNER_DECISION__ / __AI_NEED_FILES__ 等协议帧 */
export interface DecisionMarkers {
  needFiles: string[] | null
  decision: DecisionPayload | null
}

/** 从脚本 stdout 提取 __AI_NEED_FILES__ / __AI_RUNNER_DECISION__ 单行 JSON */

/**
 * 从脚本 stdout 中提取 __AI_NEED_FILES__ 与 __AI_RUNNER_DECISION__ 标记
 * [WHY] 脚本可用这两个前缀行向工作台声明"还需要哪些文件"或"当前决策选项"，比 JSON 输出更不影响人类阅读日志
 * [CONSTRAINT] 前缀后的载荷必须是单行 JSON；JSON 解析失败的行会被静默忽略，不影响其他行
 * [CHANGE-IMPACT] 结果写入 run.ts 的 summary 帧；前端 useRunner 依赖此结构渲染决策卡片
 * @param stdout 脚本的标准输出全文
 */
export function parseDecisionMarkers(stdout: string): DecisionMarkers {
  let needFiles: string[] | null = null
  let decision: DecisionPayload | null = null
  try {
    for (const line of stdout.split(String.fromCharCode(10))) {
      if (line.startsWith('__AI_NEED_FILES__')) {
        const j = JSON.parse(line.slice('__AI_NEED_FILES__'.length)) as { paths?: unknown }
        if (Array.isArray(j.paths)) needFiles = j.paths.map(String)
      } else if (line.startsWith('__AI_RUNNER_DECISION__')) {
        const j = JSON.parse(line.slice('__AI_RUNNER_DECISION__'.length)) as { question?: unknown, options?: unknown, default?: unknown }
        if (typeof j.question === 'string') {
          decision = {
            question: j.question,
            options: Array.isArray(j.options) ? (j.options as DecisionOption[]) : [],
            default: typeof j.default === 'string' ? j.default : undefined,
          }
        }
      }
    }
  } catch { /* 解析失败降级为空 */ }
  return { needFiles, decision }
}
