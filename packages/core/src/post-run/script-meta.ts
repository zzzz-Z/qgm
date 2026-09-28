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
 * 从脚本头部提取全部 @xxx 元注释（desc / why / plan / state / done / mode / ctx / changes）
 * [WHY] 元注释是脚本契约（SYSTEM.md §1.4）的载体，服务端据此决定输出裁剪、变更声明等行为
 * [CONSTRAINT] js/cjs 与 bash 均识别（// 或 # 前缀）；每个字段只取首次出现；值截断至 200 字符
 * [CHANGE-IMPACT] 新增字段须同步 ScriptMeta 接口；ctx='full' 会关闭 stdout 裁剪
 * @param script 脚本原文
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
 * 从脚本头部提取 @changes 声明的文件路径列表
 * [WHY] 与 git diff 实际变更对比可判断"声称改了但实际没动"，用于合规反馈
 * [CONSTRAINT] 仅识别 // 注释形式（bash 的 # 不支持）；逗号分隔；反斜杠会规范化为正斜杠
 * [CHANGE-IMPACT] 返回 null 表示"未声明"，返回 [] 不可能出现；调用方据此区分"未声明"与"声明为空"
 * @param script 脚本原文
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
