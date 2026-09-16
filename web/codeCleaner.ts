export interface CleanOptions {
  stripComments: boolean
  stripBlankLines: boolean
}

export interface CleanResult {
  code: string
  originalBytes: number
  cleanedBytes: number
  savedBytes: number
}

/**
 * 清洗代码：去注释、去空行。
 * 用状态机扫描，保护字符串/模板字面量里的 // /* 不被误伤。
 * 不处理正则字面量（/.../）——JS 里区分正则和除法需要完整词法分析。
 * ponytail: 覆盖 95% 场景，正则字面量里的注释符号会被误伤（罕见）。
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

function stripBlankLinesSafe(s: string): string {
  return s
    .split('\n')
    .filter(line => line.trim().length > 0)
    .join('\n')
}
