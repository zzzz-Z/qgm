// 脚本头元数据解析（@desc / @why / @plan / @done）与语言识别。
// 兼容 // 与 # 两种注释前缀（js / bash / cjs）。

// [meta-schema-unify-v1] 字段集与 core/post-run/script-meta.ts 对齐（8 字段）
/** script元数据（接口） */
export interface ScriptMeta {
  desc: string
  why: string
  plan: string
  state: string
  done: string
  mode: string
  ctx: string
  changes: string
}

/**
 * 解析 Script Meta
 * @param code - code
 */
export function parseScriptMeta(code: string): ScriptMeta {
  const pick = (name: string): string => {
    const re = new RegExp(`^[ \\t]*(?://|#)[ \\t]*@${name}[ \\t]*:?[ \\t]*(.+)$`, 'm')
    const m = code.match(re)
    return m ? m[1].trim() : ''
  }
  return {
    desc: pick('desc'),
    why: pick('why'),
    plan: pick('plan'),
    state: pick('state'),
    done: pick('done'),
    mode: pick('mode'),
    ctx: pick('ctx'),
    changes: pick('changes'),
  }
}

/** [meta-schema-unify-v1] 语言判据与 core/post-run/shebang.ts + §1.4 对齐：基于首行 shebang，不用注释前缀 */
export function detectLang(code: string): 'js' | 'bash' {
  let first = String(code).split(/\r?\n/, 1)[0] || ''
  if (first.charCodeAt(0) === 0xFEFF) first = first.slice(1)
  if (!first.startsWith('#!')) return 'js'
  return /^#!\s*(?:\/usr\/bin\/env\s+|\/bin\/|\/usr\/bin\/)?(?:bash|sh|zsh)\b/.test(first) ? 'bash' : 'js'
}
