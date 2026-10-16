// [at-ref-expand-v1] @ 引用展开：编辑插标记（@skill/<name> 或 @<path>），提交时展开为 <file> 块。
// [WHY] 替代旧 §11 的「AI 按需 loadSkill」——把确定性留给系统，而不是把决策点交给 AI。
//   实测：SYSTEM.md §11 完整写明协议，AI 依然不主动 loadSkill（本会话 12+ 轮零调用）。
// [CONSTRAINT] 展开时机在 copyAndFill 的 prependFirstPromptRules 之前；
//   展开后 prompt 含 <file path="..."> 块，first-prompt.ts 的幂等判据可复用（不重复注入规则头）。
// [CONSTRAINT] 单文件/总字节双上限：@playwright-best-practices 单 SKILL.md 可达几十 KB，
//   多个 @ 叠加会撑爆上下文。超限一律整块替换为「(超出预算已省略)」提示，不截断内容。
// [CHANGE-IMPACT] 消费方 useAiWindow.ts 的 copyAndFill；改签名需同步该处与 expand-at-refs.node-test.ts。

/** 技能引用前缀（与 file-picker.ts 的 SKILL_PICK_PREFIX 同源；此处独立定义避免 client→client 依赖） */
export const AT_SKILL_PREFIX = 'skill/'

/** 单文件内容上限（字节）；超出即整块省略，不做截断 */
export const AT_FILE_MAX_BYTES = 64 * 1024

/** 单次展开总字节上限（含所有 @ 引用累加）；超出后剩余引用省略 */
export const AT_TOTAL_MAX_BYTES = 256 * 1024

/** 匹配 `@<word>` 但不匹配 email（email 的 @ 前有字母数字且后无空格） */
const AT_REF_RE = /(^|\s)@([\w./-]+)(?=\s|$)/g

export interface ExpandDeps {
  /** 读文件内容；返回 null 表示不存在（调用方决定是否降级为原样保留） */
  readFile: (path: string) => Promise<string | null>
  /** 技能名 → 相对路径；缺省用 `.ai-runner/skills/<name>/SKILL.md` */
  skillPath?: (name: string) => string
}

export interface ExpandResult {
  /** 展开后的 prompt */
  text: string
  /** 成功展开的引用路径列表（诊断 / 测试用） */
  expanded: string[]
  /** 未命中或被省略的引用列表（诊断 / 测试用） */
  skipped: Array<{ ref: string, reason: 'not-found' | 'over-budget' }>
}

/**
 * 把 prompt 里的 `@<ref>` 展开为 `<file path="...">…</file>`。
 * [CONSTRAINT] 幂等：已含 `<file path="...">` 块时对其内的 @ 不再展开（防止嵌套展开）
 * [CONSTRAINT] 读文件失败或不存在时保留原文（不静默丢弃用户的引用意图）
 * [CONSTRAINT] 总字节上限：一旦累加超限，剩余引用全部省略并记入 skipped
 */
export async function expandAtRefs(prompt: string, deps: ExpandDeps): Promise<ExpandResult> {
  if (!prompt) return { text: prompt, expanded: [], skipped: [] }
  // [at-ref-inside-file-block-v1] 保护已有 <file> 块：把它们暂时摘出，避免对内部内容再做展开
  const fileBlockRe = /<file path="[^"]*">[\s\S]*?<\/file>/g
  const blocks: string[] = []
  const masked = prompt.replace(fileBlockRe, (m) => {
    blocks.push(m)
    return `\u0000BLOCK${blocks.length - 1}\u0000`
  })

  const expanded: string[] = []
  const skipped: ExpandResult['skipped'] = []
  let totalBytes = 0
  const replacements: Array<{ start: number, end: number, text: string }> = []

  AT_REF_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = AT_REF_RE.exec(masked)) !== null) {
    const lead = m[1]
    const raw = m[2]
    const isSkill = raw.startsWith(AT_SKILL_PREFIX)
    const rel = isSkill
      ? (deps.skillPath ? deps.skillPath(raw.slice(AT_SKILL_PREFIX.length)) : `.ai-runner/skills/${raw.slice(AT_SKILL_PREFIX.length)}/SKILL.md`)
      : raw
    const content = await deps.readFile(rel)
    if (content == null) {
      skipped.push({ ref: raw, reason: 'not-found' })
      continue
    }
    const bytes = content.length
    if (bytes > AT_FILE_MAX_BYTES || totalBytes + bytes > AT_TOTAL_MAX_BYTES) {
      skipped.push({ ref: raw, reason: 'over-budget' })
      continue
    }
    totalBytes += bytes
    const block = `<file path="${rel}">\n${content}\n</file>`
    // 保留前导空白（如行首缩进），只替换 @ 引用本体
    const start = m.index + lead.length
    const end = start + 1 + raw.length
    replacements.push({ start, end, text: block })
    expanded.push(rel)
  }

  let out = masked
  for (let i = replacements.length - 1; i >= 0; i -= 1) {
    const r = replacements[i]
    out = out.slice(0, r.start) + r.text + out.slice(r.end)
  }
  // 还原被保护的 <file> 块
  out = out.replace(/\0BLOCK(\d+)\0/g, (_x, i) => blocks[Number(i)] || '')
  return { text: out, expanded, skipped }
}
