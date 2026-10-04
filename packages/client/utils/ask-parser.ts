// @desc 解析 AI 回复中的 @ask 块：提取问题正文 + 快捷选项
// @why 支持「AI 提问 → 对话流卡片 → 用户回答 → 下一轮 prompt」的交互；
//       选项沿用 Markdown 列表语法，AI 无需学新语法；纯函数便于 vitest node 直测
// @change-impact 输出结构被 TerminalPane 的提问卡与 useAsk.askUser 共用；字段变更须同步两端

import { scanReplyMarks } from './reply-mark'

/** @ask 块的结构化载荷 */
export interface AskPayload {
  /** 问题正文（Markdown 原文，已去 @ask 前缀），卡片内用 renderMarkdown 渲染 */
  question: string
  /** 快捷选项；空数组表示卡片仅提供自由文本输入 */
  options: Array<{ id: string, label: string }>
}

/**
 * 匹配列表项（- / * / + / 1. ），与 useMarkdown.ts 的块级列表识别保持同构
 * [CONSTRAINT] 首字符用 \S 收窄，避免与 [ \t]+ 字符集重叠导致 super-linear 回溯
 */
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+\.)[ \t]+(\S.*)$/

/**
 * 显式选项区标题的正文形态（已剥离装饰后比对）
 * [WHY] [ask-options-explicit-v1] 只有显式声明的列表才当选项，见 parseAsk 三档说明
 * [CONSTRAINT] 整行匹配；不用 `.*` 兜底，避免正文里出现「选择」二字就误触发
 */
const OPTIONS_HEAD_RE = /^(?:选项|可选项|备选项|选择项|请选择|可选|options?|choices?)$/i

/**
 * 判断某行是否为「选项区标题」
 * [WHY] 先剥离 Markdown 装饰再整行比对：兼顾 `选项：` / `### 选项` / `**选项**：` 等写法，
 *   比单条长正则更易读，且无回溯风险
 * @param line 原始行文本
 */
function isOptionsHead(line: string): boolean {
  const t = line
    .trim()
    .replace(/^#{1,6}\s*/, '')
    .replace(/[*_`]/g, '')
    .replace(/[:：]\s*$/, '')
    .trim()
  return OPTIONS_HEAD_RE.test(t)
}

/**
 * 从若干行中收集列表项为选项
 * [CONSTRAINT] id 按出现顺序单调递增（opt_1 / opt_2 …），跳过空标签
 */
function collectOptions(lines: string[]): Array<{ id: string, label: string }> {
  const out: Array<{ id: string, label: string }> = []
  for (const line of lines) {
    const lm = LIST_ITEM_RE.exec(line)
    if (!lm) continue
    const label = lm[1].trim()
    if (label) out.push({ id: `opt_${out.length + 1}`, label })
  }
  return out
}

/**
 * 从 AI 回复原文提取 @ask 载荷
 * [WHY] 返回 null 表示非 @ask，调用方继续走原有分支（plain / done / multi）
 * [CONSTRAINT] 只处理首个 ASK 块；标记必须**独占一行**且落在首个非空行
 *   （`ASK 问题` 这类同行写法不识别），正文从第二行起
 *
 * [ask-options-explicit-v1] 选项识别分三档（旧实现「所有列表项都当选项」，
 * 会把提问正文里的现状列举（`现状：` + `- A` + `- B`）误渲染成可点按钮）：
 *   一档 · 存在显式选项区标题（`选项：` / `请选择：` / `Options:`）→ 只取其后的列表项为选项；
 *   二档 · 无标题但「正文非列表行 ≤ 1 且列表项 ≥ 2」→ 判为选项（覆盖「一句话 + 纯列表」的短问法）；
 *   三档 · 其余一律不给选项 → 正文列表原样留在 question 里，
 *          最坏后果是少几个按钮（用户仍可自由输入），而不是让用户点错选项。
 *
 * @param text AI 回复原文；空串/非 @ask 返回 null
 */
export function parseAsk(text: string): AskPayload | null {
  const raw = String(text ?? '')
  // [reply-mark-v1] 标记判定统一走 scanReplyMarks：只看首个非空行的独占标记行
  //   （`ASK`，或过渡别名 `@ask`）。与浏览器侧 headless-inject 的门槛共用同一套判据，
  //   不再存在「一边认一边不认」的窗口。
  const scan = scanReplyMarks(raw)
  if (scan.ask <= 0) return null

  // [reply-mark-v1] 标记行独占一行 → 问题正文 = 标记行之后的**所有行**
  //   （旧协议允许 `@ask 问题` 同行，需额外剥离该行前缀；现在那一行只剩标记本身）
  const body = raw.split(/\r?\n/).slice(scan.ask).join('\n').trim()
  if (!body) return { question: '', options: [] }

  const lines = body.split('\n')

  // 一档：显式选项区标题
  const headIdx = lines.findIndex(isOptionsHead)
  if (headIdx >= 0) {
    const options = collectOptions(lines.slice(headIdx + 1))
    // [CONSTRAINT] 标题后没有列表项时视为普通正文，落回三档，避免吞掉这句话
    if (options.length > 0) {
      return { question: lines.slice(0, headIdx).join('\n').trim(), options }
    }
  }

  // 二档：正文极短 + 纯列表 —— 典型的「请选一个：」+ 选项
  const proseLines = lines.filter(l => l.trim().length > 0 && !LIST_ITEM_RE.test(l))
  const listCount = lines.length - proseLines.length - lines.filter(l => !l.trim()).length
  if (listCount >= 2 && proseLines.length <= 1) {
    return { question: proseLines.join('\n').trim(), options: collectOptions(lines) }
  }

  // 三档：保守 —— 不提供选项
  return { question: body, options: [] }
}
