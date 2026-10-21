'use strict'
// @desc 从 DONE 播报里导出 conventional commit 标题的纯逻辑（无副作用、可被守卫直接 import）
// @why post-done-gate v1 每次 DONE 都会在当前分支落一个 checkpoint commit，而 AI 的 DONE 播报
//   是**对话体自由文本**（实测最长标题 335 字符、连续数百字），直接当 subject 会把整段播报
//   塞进 git log ⇒ `git log --oneline` 失去判别力，且 0 个 tag 时完全不可追溯。
//   本库把「约定一行 COMMIT:」变成可判定的解析，缺失/非法时**明确降级**而不是静默吞掉。
// @change-impact 改本文件的 type 白名单或长度上限，守卫 commit-subject-guard 必须同步变红。
//
// [CONSTRAINT] 与 scripts/lib/turn-schema-io.mjs 同一范式：库 + 薄入口。
//   入口（bin/post-done.cjs）只做 IO，守卫 import 本文件即得同一套算法。

/** 允许的 conventional commit type（与 §12 契约逐字对应） */
const VALID_TYPES = ['feat', 'fix', 'chore', 'refactor', 'docs', 'test', 'perf']

/** subject 总长上限（含 `type(scope): ` 前缀） */
const MAX_SUBJECT = 72

/** 降级路径的摘要截断长度（沿用 post-done-gate v1 既有行为） */
const FALLBACK_MAX = 120

const TYPE_ALT = VALID_TYPES.join('|')

/** 完整形态：`fix(headless): 修正触顶正则自指` */
// [CONSTRAINT] ① scope 组用非捕获包裹（`(?:...)`)，否则 lint 报 unused-capturing-group；
//   ② 标题正文用 `\S.*` 而非 `.+`：冒号后的 ` *` 与 `.*` 字符类重叠会被 regexp 插件判为
//   可回溯（no-super-linear-backtracking）。`\S` 保证正文非空，重叠面消失。
const RE_COMMIT = new RegExp(`^(${TYPE_ALT})(?:\\(([^)]+)\\))?: *(\\S.*)$`)

/**
 * 把 DONE 摘要解析成 git commit subject。
 *
 * [CONSTRAINT] 客户端（useAiReplyHandlers）用 ' / ' 拼 DONE 播报的前 5 行，
 *   故 COMMIT: 行只能出现在这 5 行**之内**，且必须是一段独立的 ' / ' 分隔片段。
 *
 * @param {string} doneSummary DONE 播报摘要（已由客户端拼接/截断）
 * @returns {{ subject: string, source: 'commit-line'|'fallback', type?: string, scope?: string }} 标题与来源；`source==='fallback'` 表示没按契约写 COMMIT: 行
 */
function parseCommitSubject(doneSummary) {
  const raw = String(doneSummary || '')

  // ---- 主路径：找 `COMMIT: ...` 行 ----
  for (const seg of raw.split(' / ')) {
    const line = seg.trim()
    if (!line.startsWith('COMMIT:')) continue
    const rest = line.slice('COMMIT:'.length).trim()
    if (!rest) break // 空 COMMIT: ⇒ 视为有意标注但写坏了，走降级（不静默造标题）
    const m = RE_COMMIT.exec(rest)
    if (!m) break // type 非法 / 缺冒号 ⇒ 降级，绝不用非法文本冒充 conventional commit
    const type = m[1]
    const scope = m[2] || ''
    const desc = m[3].trim()
    const head = scope ? `${type}(${scope}): ` : `${type}: `
    const subject = `${head}${desc}`.slice(0, MAX_SUBJECT)
    return { subject, source: 'commit-line', type, scope }
  }

  // ---- 降级：沿用 post-done-gate v1 的既有行为（首个非标题片段）----
  const segs = raw.split(' / ').map(x => x.trim()).filter(x => x.length > 0)
  const first = segs.find(x => !x.startsWith('#')) || (segs[0] || '').replace(/^#+\s*/, '')
  const subject = `chore(done): ${first.replace(/"/g, '\'').slice(0, FALLBACK_MAX)}`
  return { subject, source: 'fallback' }
}

module.exports = { parseCommitSubject, VALID_TYPES, MAX_SUBJECT, FALLBACK_MAX }
