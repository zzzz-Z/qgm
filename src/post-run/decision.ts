// [refactor-post-run] 协议标记解析（helpers.cjs 单行 JSON）

export interface DecisionOption { id: string, label: string }
export interface DecisionPayload {
  question: string
  options: DecisionOption[]
  default?: string
}

export interface DecisionMarkers {
  needFiles: string[] | null
  decision: DecisionPayload | null
}

/** 从脚本 stdout 提取 __AI_NEED_FILES__ / __AI_RUNNER_DECISION__ 单行 JSON */
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
