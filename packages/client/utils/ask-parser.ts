// @desc 解析 AI 回复中的 @ask 块：提取问题正文 + 快捷选项
// @why 支持「AI 提问 → 前端弹窗 → 用户回答 → 下一轮 prompt」的交互（SYSTEM.md §1.5）；
//       选项沿用 Markdown 列表语法，AI 无需学新语法；纯函数便于 vitest node 直测
// @change-impact 输出结构被 AskDialog.vue（下一轮）与 useAutoLoop.submitAsk 共用；字段变更须同步两端

/** @ask 块的结构化载荷 */
export interface AskPayload {
  /** 问题正文（Markdown 原文，已去 @ask 前缀），弹窗内用 renderMarkdown 渲染 */
  question: string
  /** 快捷选项；空数组表示弹窗仅提供自由文本输入 */
  options: Array<{ id: string, label: string }>
}

/**
 * 识别 @ask 起始：trim 后整段以 @ask 开头（带词边界，@asks 不匹配）
 * [CONSTRAINT] 只匹配首个；行内出现的 "@ask" 不算触发
 */
const ASK_HEAD_RE = /^\s*@ask\b[ \t]*/i

/**
 * 匹配列表项（- / * / + / 1. ），与 useMarkdown.ts 的块级列表识别保持同构
 * [CONSTRAINT] 首字符用 \S 收窄，避免与 [ \t]+ 字符集重叠导致 super-linear 回溯
 */
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+\.)[ \t]+(\S.*)$/

/**
 * 从 AI 回复原文提取 @ask 载荷
 * [WHY] 返回 null 表示非 @ask，调用方继续走原有分支（plain / done / multi）
 * [CONSTRAINT] 只处理首个 @ask 块；不剥离代码围栏（SYSTEM.md §1.5 约定 AI 不得输出围栏）
 * @param text AI 回复原文；空串/非 @ask 返回 null
 */
export function parseAsk(text: string): AskPayload | null {
  const raw = String(text ?? '')
  const m = ASK_HEAD_RE.exec(raw)
  if (!m) return null

  const body = raw.slice(m[0].length).trim()
  if (!body) return { question: '', options: [] }

  const questionLines: string[] = []
  const options: Array<{ id: string, label: string }> = []

  for (const line of body.split('\n')) {
    const lm = LIST_ITEM_RE.exec(line)
    if (lm) {
      const label = lm[1].trim()
      if (label) options.push({ id: `opt_${options.length + 1}`, label })
    } else {
      questionLines.push(line)
    }
  }

  return {
    question: questionLines.join('\n').trim(),
    options,
  }
}
