// [strip-script-blocks-v1] 从文本中剥离「形似脚本的内容」，避免脚本正文被当普通文本渲染。
// [WHY] 分类器把语言非白名单（或标记误判）的回复判为 plain → 脚本正文进 text 卡 → 噪音。
//   渲染前剥离是前端侧的最后一道防线（采集侧收紧属另一条通道，改面更大）。
// [CONSTRAINT] 两种形态都处理：① 围栏块（``` 包裹）；② 无围栏（脚本头行起剥到末尾）。
//   判据是「脚本头契约特征」：shebang / // @desc / # @desc —— 普通代码示例无这些特征，保留。
// [CHANGE-IMPACT] 结果为空串时调用方应跳过渲染（纯脚本噪音，无剩余内容）。

/** 脚本头行判据：shebang 或脚本头注释（与 reply-mark 契约特征一致） */
function isScriptHeaderLine(line: string): boolean {
  const t = line.trim()
  if (/^#!\s*\//.test(t)) return true
  if (/^\/\/\s*@desc\b/.test(t)) return true
  if (/^#\s*@desc\b/.test(t)) return true
  return false
}

/** 形似脚本的判据：块内任一行是脚本头行 */
function looksLikeScript(blockLines: readonly string[]): boolean {
  return blockLines.some(isScriptHeaderLine)
}

/** 围栏行判据：以三个反引号开头（允许前导空白） */
const FENCE_RE = /^\s*```|```\s*$/
/** 围栏闭合判据：整行仅三个反引号与空白 */
const FENCE_CLOSE_RE = /^\s*```\s*$/

/**
 * 剥离文本中的「脚本内容」
 * [WHY] 脚本正文被误分类为 plain 时会渲染进 text 卡；渲染前剥掉可消除噪音。
 * [CONSTRAINT] 无围栏时从首个脚本头行起剥到末尾（脚本头之后是脚本正文，非普通文本）；
 *   未闭合围栏（流式中间态）原样保留；无脚本特征的围栏块原样保留。
 * @param text 原始文本（Markdown）
 * @returns 剥离脚本后的文本（可能为空串）
 */
export function stripScriptBlocks(text: string): string {
  const lines = String(text || '').split(/\r?\n/)
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    // 形态 ①：围栏块
    if (FENCE_RE.test(line)) {
      let j = i + 1
      while (j < lines.length && !FENCE_CLOSE_RE.test(lines[j])) j++
      if (j >= lines.length) {
        // 未闭合：原样保留（流式中间态，不误吞）
        out.push(...lines.slice(i))
        break
      }
      if (!looksLikeScript(lines.slice(i + 1, j))) {
        out.push(...lines.slice(i, j + 1))
      }
      i = j + 1
      continue
    }
    // 形态 ②：无围栏 —— 脚本头行起剥到末尾
    if (isScriptHeaderLine(line)) {
      break
    }
    out.push(line)
    i++
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
