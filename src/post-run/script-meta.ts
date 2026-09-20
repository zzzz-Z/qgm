// [refactor-post-run] 脚本头元信息解析（@desc/@why/@mode/@changes）
export interface ScriptMeta {
  desc: string
  why: string
  /** [P3-2d] 脚本头 @mode 元信息；diff = 只读预览模式 */
  mode: string
}

/**
 * 从脚本首部解析 @desc / @why 元注释。
 * - cjs：`// @desc: ...` / `// @why: ...`
 * - bash：`# @desc: ...` / `# @why: ...`
 * 失败字段为空字符串，不阻塞执行（降级显示「AI 未提供说明」）。
 */
export function parseScriptMeta(script: string): ScriptMeta {
  const out: ScriptMeta = { desc: '', why: '', mode: '' }
  const re = /^\s*(?:\/\/|#)\s*@(desc|why|mode)\s*:\s*(.+)$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(script)) !== null) {
    const key = m[1] === 'desc' ? 'desc' : (m[1] === 'mode' ? 'mode' : 'why')
    if (!out[key]) out[key] = m[2].trim().slice(0, 200)
  }
  return out
}
export function parseClaimed(script: string): string[] | null {
  const out: string[] = []
  const re = /^\s*\/\/\s*@changes\s*:\s*(.+)$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(script)) !== null) {
    for (const part of m[1].split(',')) {
      const p = part.trim().replace(/\\/g, '/')
      if (p) out.push(p)
    }
  }
  return out.length ? out : null
}
