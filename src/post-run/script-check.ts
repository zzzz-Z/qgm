import vm from 'node:vm'

/** [L2] 脚本语法预检：剥 shebang 后用 vm.Script 解析，不执行 */
export function checkScriptSyntax(code: string): { ok: true } | { ok: false, error: string } {
  const cleaned = code.replace(/^#!.*\n/, '')
  try {
    // eslint-disable-next-line no-new -- 仅做语法解析
    new vm.Script(cleaned)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
