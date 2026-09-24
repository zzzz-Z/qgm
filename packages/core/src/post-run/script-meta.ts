// 脚本头元信息解析（@desc/@why/@mode/@changes）

// [meta-schema-unify-v1] 字段集与 client/utils/scriptMeta.ts 对齐（8 字段）
/** 脚本头元信息：@desc / @why / @mode / @ctx / @changes */
export interface ScriptMeta {
  desc: string
  why: string
  plan: string
  state: string
  done: string
  /** [P3-2d] 脚本头 @mode 元信息；diff = 只读预览模式 */
  mode: string
  /** [ctx] 输出截断策略：full = 全量不裁剪；缺省 = 按需裁剪 */
  ctx: string
  /** [changes] 逗号分隔的预期变更文件路径（parseClaimed 会展开） */
  changes: string
}

/**
 * 从脚本首部解析 @desc / @why 元注释。
 * - cjs：`// @desc: ...` / `// @why: ...`
 * - bash：`# @desc: ...` / `# @why: ...`
 * 失败字段为空字符串，不阻塞执行（降级显示「AI 未提供说明」）。
 */

/**
 * 解析 Script Meta
 * @param script - script
 */
export function parseScriptMeta(script: string): ScriptMeta {
  const out: ScriptMeta = { desc: '', why: '', plan: '', state: '', done: '', mode: '', ctx: '', changes: '' }
  const re = /^[^\S\n]*(?:\/\/|#)[^\S\n]*@(desc|why|plan|state|done|mode|ctx|changes)[^\S\n]*(?::[^\S\n]*)?(\S[^\n]*)$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(script)) !== null) {
    const key = m[1] as 'desc' | 'why' | 'plan' | 'state' | 'done' | 'mode' | 'ctx' | 'changes'
    if (!out[key]) out[key] = m[2].trim().slice(0, 200)
  }
  return out
}
/**
 * 解析 Claimed
 * @param script - script
 */
export function parseClaimed(script: string): string[] | null {
  const out: string[] = []
  const re = /^[^\S\n]*\/\/[^\S\n]*@changes[^\S\n]*:[^\S\n]*(\S[^\n]*)$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(script)) !== null) {
    for (const part of m[1].split(',')) {
      const p = part.trim().replace(/\\/g, '/')
      if (p) out.push(p)
    }
  }
  return out.length ? out : null
}
