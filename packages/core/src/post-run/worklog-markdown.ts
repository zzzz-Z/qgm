// [worklog-markdown-v1] 从 git.ts 抽出：工作日志 Markdown 组装（纯函数）
// [WHY] git.ts 超架构红线的 400 行限；本函数只做字符串拼装，无 IO 依赖，适合独立模块

/** 单个文件在工作日志中的变更记录 */
export interface WorklogFileEntry {
  path: string
  /** added / modified / deleted / renamed / copied */
  status: string
  added: number
  removed: number
  /**
   * 原始 unified diff 文本（以 `diff --git` 开头），用于日志填写而非概括
   * [CONSTRAINT] 每个文件行数超过上限时截断为首尾拼接；上层消费无需担心超长
   * [CHANGE-IMPACT] 由 buildWorklogMarkdown 直接以代码围栏输出；未提供时该文件不渲染详细段
   */
  diff?: string
}

/**
 * 组装工作日志 Markdown
 * [CONSTRAINT] 与 gitWorklog 返回结构严格配对；字段重命名需同步本函数
 */
export function buildWorklogMarkdown(worklog: { since: string, until: string, generatedAt: number, files: WorklogFileEntry[], history: string[], stat: string }): string {
  // [worklog-v1] Q = 反引号字符；FENCE = 三反引号代码围栏；避免模板字符串内转义
  const Q = String.fromCharCode(96)
  const FENCE = Q + Q + Q
  const dt = new Date(worklog.generatedAt)
  const pad = (n: number): string => String(n).padStart(2, [48].map(c => String.fromCharCode(c)).join(''))
  const dateStr = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
  const timeStr = `${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`
  const stamp = `${dateStr} ${timeStr}`
  const out: string[] = []
  out.push(`# 工作日志 · ${stamp}`)
  out.push('')
  const scope = worklog.until ? worklog.until : '工作区（含未提交与未跟踪）'
  out.push(`**范围**: ${Q}${worklog.since}${Q} → ${worklog.until ? Q + worklog.until + Q : scope}`)
  out.push(`**文件数**: ${worklog.files.length}`)
  out.push('')
  out.push('## 变更概览')
  out.push('')
  if (worklog.files.length === 0) {
    out.push('（无变更）')
  } else {
    out.push('| 文件 | 状态 | +行 | -行 |')
    out.push('| :--- | :--- | ---: | ---: |')
    for (const f of worklog.files) out.push(`| ${Q}${f.path}${Q} | ${f.status} | ${f.added} | ${f.removed} |`)
  }
  out.push('')
  // [worklog-detail-v1] 逐文件输出原始 diff（4 反引号围栏，避免 diff 内容里的三反引号破窗）
  // [WHY] 用户要求"不要简单总结"，作为日志填写需要看到实际改动；本段为工作日志的核心内容
  const FENCE4 = Q + Q + Q + Q
  const detailFiles = worklog.files.filter(f => f.diff)
  if (detailFiles.length) {
    out.push('## 详细变更')
    out.push('')
    for (const f of detailFiles) {
      out.push(`### ${Q}${f.path}${Q} — ${f.status} (+${f.added} / -${f.removed})`)
      out.push('')
      out.push(`${FENCE4}diff`)
      out.push(String(f.diff).trim())
      out.push(FENCE4)
      out.push('')
    }
  }
  if (worklog.stat.trim()) {
    out.push('## 统计')
    out.push('')
    out.push(FENCE)
    out.push(worklog.stat.trim())
    out.push(FENCE)
    out.push('')
  }
  if (worklog.history.length) {
    out.push('## 最近提交')
    out.push('')
    for (const h of worklog.history) out.push(`- ${h}`)
    out.push('')
  }
  return out.join('\n')
}
