/**
 * [ansi-render-v1] 把含 ANSI SGR 色码的日志转成**转义安全**的 HTML 片段。
 *
 * [WHY] 源头（run-script 注入 FORCE_COLOR=1）保留色码后，`{{ }}` 纯文本插值会显示成 `^[[32m` 乱码；
 *   转 HTML 才能在 <pre> 里着色。内容来自 AI 脚本输出 ⇒ 不可信，必须先转义再注入色标签。
 *
 * [CONSTRAINT] 只认 SGR 前景/加粗/暗淡（30-37 / 90-97 / 1 / 2 / 22 / 39），
 *   其余转义序列（光标、擦除等）一律丢弃；不解析未知序列，避免逃逸出标签。
 *
 * @param raw 原始文本（可含 ESC[..m）
 * @returns 已转义的 HTML 片段（可直接 v-html）
 */

/** ANSI SGR 前景色参数 → CSS 类名；仅覆盖常见 16 色 */
const FG: Record<string, string> = {
  30: 'a-black',
  31: 'a-red',
  32: 'a-green',
  33: 'a-yellow',
  34: 'a-blue',
  35: 'a-magenta',
  36: 'a-cyan',
  37: 'a-white',
  90: 'a-bright-black',
  91: 'a-bright-red',
  92: 'a-bright-green',
  93: 'a-bright-yellow',
  94: 'a-bright-blue',
  95: 'a-bright-magenta',
  96: 'a-bright-cyan',
  97: 'a-bright-white',
}

/** FG 值集合：切换前景色时清掉旧色类（保留 bold/dim） */
const FG_KEYS = new Set(Object.values(FG))

/** HTML 转义：& < > " 全转，杜绝注入 */
function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 匹配 ANSI SGR 序列（ESC[<params>m） */
const ANSI_RE = (() => {
  const ESC = String.fromCharCode(27)
  return new RegExp(`${ESC}\\[([0-9;]*)m`, 'g')
})()

/** 残余控制序列（光标/擦除等非 SGR）：在文本段一律剥离，避免漏出不可见控制字符 */
const CTRL_RE = (() => {
  const ESC = String.fromCharCode(27)
  return new RegExp(`${ESC}\\[[0-9;?]*[a-z]`, 'gi')
})()

/** 把一段文本按 ANSI SGR 转成转义安全的 HTML */
export function ansiToHtml(raw: string): string {
  const text = String(raw ?? '')
  let out = ''
  let cls: string[] = []
  let last = 0
  const push = (s: string): void => {
    if (!s) return
    const body = escHtml(s.replace(CTRL_RE, ''))
    if (!cls.length) { out += body; return }
    out += `<span class="${cls.join(' ')}">${body}</span>`
  }
  let m: RegExpExecArray | null
  ANSI_RE.lastIndex = 0
  while ((m = ANSI_RE.exec(text)) !== null) {
    push(text.slice(last, m.index))
    last = m.index + m[0].length
    const codes = m[1] ? m[1].split(';') : ['0']
    for (const c of codes) {
      if (c === '0' || c === '') { cls = []; continue }
      if (c === '1') { if (!cls.includes('a-bold')) cls.push('a-bold'); continue }
      if (c === '2') { if (!cls.includes('a-dim')) cls.push('a-dim'); continue }
      if (c === '22') { cls = cls.filter(x => x !== 'a-bold' && x !== 'a-dim'); continue }
      if (c === '39') { cls = cls.filter(x => !FG_KEYS.has(x)); continue }
      const fg = FG[c]
      if (fg) { cls = cls.filter(x => !FG_KEYS.has(x)); cls.push(fg) }
    }
  }
  push(text.slice(last))
  return out
}
