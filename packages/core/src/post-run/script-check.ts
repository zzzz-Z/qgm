import vm from 'node:vm'

// 兼容多形态 shebang：BOM / 前导空白 / LF / CRLF / CR
// 剥离失败时，附带前 80 字符预览便于定位非法字符

/**
 * 用 node vm.Script 做语法预检（不执行）
 * [WHY] 语法错误是 AI 回填脚本最常见的形态；预检能提前报错避免污染 execute 阶段
 * [CONSTRAINT] 只做语法解析，不校验契约字段；多段尝试策略见函数体
 * [CHANGE-IMPACT] 返回结构被 run.ts 用于 400 提前拦截；错误消息会作为 stderr 反馈给用户
 * @param code 待检脚本原文
 */
export function checkScriptSyntax(code: string): { ok: true } | { ok: false, error: string } {
  const tryParse = (src: string): string | null => {
    try {
      // eslint-disable-next-line no-new -- 仅做语法解析
      new vm.Script(src)
      return null
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }

  // 1. 原样
  let err = tryParse(code)
  if (err === null) return { ok: true }

  // 2. 剥 BOM + 前导空白 + shebang 行
  const stripped = code
    .replace(/^\uFEFF/, '')
    .replace(/^\s*#![^\r\n]*(?:\r\n|\r|\n)?/, '')
  if (stripped !== code) {
    err = tryParse(stripped)
    if (err === null) return { ok: true }
  }

  // 3. 兜底：剥首行
  const nl = code.indexOf('\n')
  if (nl > 0 && nl < code.length - 1) {
    const rest = code.slice(nl + 1)
    const err2 = tryParse(rest)
    if (err2 === null) return { ok: true }
  }

  const preview = code.slice(0, 80).replace(/\r/g, '\\r').replace(/\n/g, '\\n')
  return { ok: false, error: `${err}（前 80 字符：${preview}）` }
}
