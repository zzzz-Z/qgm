// [timeline-denoise-v1] 信息展示区降噪：长文本预览与原始输出尾部折叠的纯函数集合。
// [WHY] AI 中间回复、用户长提问（含附件全文）动辄数百行，直出会形成"文字墙"，
//   用户真正关心的「这轮改了什么」被淹没。参照成熟编码智能体的信息流范式——
//   默认只呈现可扫读的预览，完整内容按需展开。
// [CONSTRAINT] 纯函数、无 Vue / DOM 依赖；便于单测覆盖边界（空串、单行、恰好等于阈值、超长单行）。
// [CHANGE-IMPACT] 仅被 TerminalPane.vue / ScriptCard.vue 消费；阈值均有默认值，
//   调整默认值不需改动调用点。

/** 长文本预览结果 */
export interface TextPreview {
  /** 截断后的预览文本（未截断时等于原文） */
  preview: string
  /** 是否发生了截断（行数或字符数任一超限） */
  truncated: boolean
  /** 被折叠掉的整行数；truncated=false 时恒为 0 */
  hiddenLines: number
  /** 归一化后的原文总行数（空输入为 0） */
  totalLines: number
}

/** 原始输出尾部折叠结果 */
export interface TailPreview {
  /** 保留的尾部文本（不含省略提示，提示由调用方按 hiddenLines 渲染） */
  text: string
  /** 被丢弃的整行数 */
  hiddenLines: number
}

/**
 * 归一化行文本：统一换行符、去掉尾部空行、纯空白视作空
 * [WHY] ① stdout 混用 CRLF / LF 且常以换行结尾，不归一化会让 totalLines 虚高一行，
 *   使"恰好等于阈值"的文本被误判为需要折叠；② 纯空白（空格 / 换行）在展示上等同无内容，
 *   返回 '' 可让调用方走空态分支，不渲染一张空卡。
 * [CONSTRAINT] 只对"整体纯空白"生效，保留行内缩进（`  a` 的前导空格不能被 trim）。
 */
function normalizeText(text: string): string {
  const norm = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '')
  return norm.trim() ? norm : ''
}

/**
 * 生成长文本的可扫读预览
 * [WHY] 成熟编码智能体对中间过程一律"先摘要后展开"；行数与字符数双阈值可同时挡住
 *   "行少但单行极长"（如压缩 JSON）与"行多但每行很短"（如表格）两类文字墙。
 * [CONSTRAINT] 逐行累加，遇到任一阈值即停；preview 自身不超过 maxChars。
 * @param text 原始文本（markdown 或纯文本）
 * @param maxLines 允许保留的最大行数（含被字符数截断的那一行）
 * @param maxChars 允许保留的最大字符数
 */
export function clampTextPreview(text: string, maxLines = 12, maxChars = 800): TextPreview {
  const norm = normalizeText(text)
  if (!norm) return { preview: '', truncated: false, hiddenLines: 0, totalLines: 0 }
  const lines = norm.split('\n')
  const totalLines = lines.length
  const kept: string[] = []
  let used = 0
  let truncated = false
  for (let i = 0; i < lines.length; i++) {
    if (i >= maxLines) { truncated = true; break }
    const line = lines[i]
    const sep = kept.length ? 1 : 0
    if (used + sep + line.length > maxChars) {
      const room = maxChars - used - sep
      if (room > 0) kept.push(line.slice(0, room))
      truncated = true
      break
    }
    kept.push(line)
    used += sep + line.length
  }
  return {
    preview: kept.join('\n'),
    truncated,
    hiddenLines: Math.max(0, totalLines - kept.length),
    totalLines,
  }
}

/**
 * 折叠原始输出的尾部行
 * [WHY] 脚本卡只需让用户确认"跑完了、末尾长什么样"，全量输出属于噪音；
 *   但直接给字符切片会以半行开头（如残缺的绝对路径），故按行保留并显式报告省略行数。
 * [CONSTRAINT] 上游若已按字符数截断（raw.length >= maxChars），首行大概率是半行 → 丢弃，
 *   并把这半行一并计入 hiddenLines，保证「省略 N 行」的文案与实际丢失内容一致；
 *   单行输入不丢，避免出现"有输入却无预览"。
 * @param raw 原始输出（stdout 或 stderr）
 * @param keepLines 保留的尾部行数
 * @param maxChars 上游截断长度参考值，同时作为返回文本的字符上限
 */
export function tailTextPreview(raw: string, keepLines = 5, maxChars = 400): TailPreview {
  const src = String(raw ?? '')
  const norm = normalizeText(src)
  if (!norm) return { text: '', hiddenLines: 0 }
  const all = norm.split('\n')
  const droppedHead = (src.length >= maxChars && all.length > 1) ? 1 : 0
  const body = droppedHead ? all.slice(1) : all
  const kept = body.slice(-Math.max(1, keepLines))
  const hiddenLines = Math.max(0, body.length - kept.length) + droppedHead
  let text = kept.join('\n')
  if (text.length > maxChars) text = text.slice(-maxChars)
  return { text, hiddenLines }
}
