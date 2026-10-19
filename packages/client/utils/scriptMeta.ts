// 脚本头元数据解析（@desc / @why / @plan）与语言识别。
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
 * 从前端视角解析脚本头部的 @xxx 元注释
 * [WHY] 与 core/post-run/script-meta.ts 并行存在：前端需要在不调用服务端时也能读到 desc/why（模板预览等）
 * [CONSTRAINT] js/cjs 用 // 前缀、bash 用 # 前缀；pick 每个字段只取首次出现；未命中返回空串
 * [CHANGE-IMPACT] 与服务端版解析逻辑须保持字段集一致；新增元注释须两侧同步
 * @param code 脚本原文
 */
export function parseScriptMeta(code: string): ScriptMeta {
  const pick = (name: string): string => {
    // [meta-word-boundary-v1] 加 \b：原正则会误匹配 @descriptor → desc = "riptor …"（报告 P2）
    const re = new RegExp(`^[ \\t]*(?://|#)[ \\t]*@${name}\\b[ \\t]*:?[ \\t]*(.+)$`, 'm')
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

/**
 * [script-head-autofill-v1] 用信封的 desc/why 补齐脚本头注释（`// @desc` / `// @why`）。
 * [WHY] 信封路径下 desc/why 是 JSON 字段：AI 按 §1.4 只填信封、`code` 不写头时，脚本到达
 *   /run 会被头契约（scanScriptHead）以 MISSING_DESC 400 拒收——实测该原因占全部拒收首位
 *   （473 次）。在接线层统一补齐，下游（头契约 / parseScriptMeta / 去重指纹 / 卡片）零改动。
 * [CONSTRAINT] 幂等：已有 @desc/@why 的项不重复补；两值均空则原样返回（手动运行路径不受影响）。
 *   头注释必须落在 shebang **之后**——shebang 只在首行合法，抢在它前面会让头校验失真。
 * @param code 脚本原文
 * @param desc 信封 desc 字段
 * @param why 信封 why 字段
 */
export function ensureScriptHead(code: string, desc?: string, why?: string): string {
  const src = String(code ?? '')
  if (!src) return src
  const oneLine = (v?: string): string => String(v ?? '').split(/\r?\n/)[0].trim().slice(0, 200)
  const hasField = (name: string): boolean => new RegExp(`^[ \\t]*(?://|#)[ \\t]*@${name}\\b`, 'm').test(src)
  const head: string[] = []
  const descText = oneLine(desc)
  const whyText = oneLine(why)
  if (descText && !hasField('desc')) head.push(`// @desc ${descText}`)
  if (whyText && !hasField('why')) head.push(`// @why ${whyText}`)
  if (!head.length) return src
  const lines = src.split(/\r?\n/)
  const shebang = lines[0].startsWith('#!') ? String(lines.shift() ?? '') : ''
  return `${[shebang, ...head].filter(Boolean).join('\n')}\n${lines.join('\n')}`
}

/** [meta-schema-unify-v1] 语言判据与 core/post-run/shebang.ts + 脚本头契约对齐：基于首行 shebang，不用注释前缀 */
export function detectLang(code: string): 'js' | 'bash' {
  let first = String(code).split(/\r?\n/, 1)[0] || ''
  if (first.charCodeAt(0) === 0xFEFF) first = first.slice(1)
  if (!first.startsWith('#!')) return 'js'
  return /^#!\s*(?:\/usr\/bin\/env\s+|\/bin\/|\/usr\/bin\/)?(?:bash|sh|zsh)\b/.test(first) ? 'bash' : 'js'
}
