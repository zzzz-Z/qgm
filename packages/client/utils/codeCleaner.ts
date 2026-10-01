/** 代码清洗选项；[CONSTRAINT] 两个开关独立生效，无依赖顺序 */
export interface CleanOptions {
  stripComments: boolean
  stripBlankLines: boolean
}

/** cleanCode 的执行结果；[CONSTRAINT] savedBytes 恒等于 originalBytes - cleanedBytes，供 UI 展示"节省多少" */
interface CleanResult {
  code: string
  originalBytes: number
  cleanedBytes: number
  savedBytes: number
}

/**
 * 清洗代码：去注释、去空行、去行尾空白
 * [WHY] 用状态机扫描保护字符串 / 模板字面量里的 `//` 与 `/*`，避免误删内容
 * [CONSTRAINT] 不处理正则字面量（/.../）—— JS 里区分正则与除法需完整词法分析；正则内的注释符会被误伤（罕见）
 * [CHANGE-IMPACT] 输出被 contextBuilder 用于 prompt 压缩；savedBytes 影响前端"节省"展示
 * @param src 原始源码
 * @param opts 清洗选项；关闭开关时对应步骤跳过
 */
export function cleanCode(src: string, opts: CleanOptions): CleanResult {
  const originalBytes = src.length
  let s = src
  if (opts.stripComments) s = stripCommentsSafe(s)
  if (opts.stripBlankLines) s = stripBlankLinesSafe(s)
  s = s.replace(/[ \t]+$/gm, '')
  const cleanedBytes = s.length
  return { code: s, originalBytes, cleanedBytes, savedBytes: originalBytes - cleanedBytes }
}

/**
 * 剥除注释但保护字符串 / 模板字面量内容
 * [CONSTRAINT] 状态机覆盖 code / line / block / single / double / template 六态；转义字符不切换态
 * [WHY] 块注释内的换行保留（避免行号完全错乱）；行注释的换行也保留
 * @param src 已通过 cleanCode 分发的源码片段
 */
function stripCommentsSafe(src: string): string {
  let out = ''
  let i = 0
  type State = 'code' | 'line' | 'block' | 'single' | 'double' | 'template'
  let state: State = 'code'

  while (i < src.length) {
    const ch = src[i]
    const next = src[i + 1]

    if (state === 'code') {
      if (ch === '/' && next === '/') { state = 'line'; i += 2; continue }
      if (ch === '/' && next === '*') { state = 'block'; i += 2; continue }
      if (ch === '\'') { state = 'single'; out += ch; i++; continue }
      if (ch === '"') { state = 'double'; out += ch; i++; continue }
      if (ch === '`') { state = 'template'; out += ch; i++; continue }
      out += ch
      i++
      continue
    }

    if (state === 'line') {
      if (ch === '\n') { state = 'code'; out += ch }
      i++
      continue
    }

    if (state === 'block') {
      if (ch === '*' && next === '/') { state = 'code'; i += 2; continue }
      if (ch === '\n') out += ch // 保留换行，避免行号完全错乱
      i++
      continue
    }

    // single / double / template
    if (ch === '\\') {
      out += ch + (next ?? '')
      i += 2
      continue
    }
    out += ch
    if (state === 'single' && ch === '\'') state = 'code'
    else if (state === 'double' && ch === '"') state = 'code'
    else if (state === 'template' && ch === '`') state = 'code'
    i++
  }
  return out
}

/**
 * 删去纯空白行（含仅含空格 / Tab 的行）
 * [CONSTRAINT] trim 后长度 0 即视为空行；一次性 filter 全部去除，不合并连续空行为单行
 */
function stripBlankLinesSafe(text: string): string {
  return text
    .split('\n')
    .filter(line => line.trim().length > 0)
    .join('\n')
}
