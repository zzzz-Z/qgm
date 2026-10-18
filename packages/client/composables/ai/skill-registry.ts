// [skill-registry-v3] 按任务检索技能正文；空 query 不注入任何内容
// [WHY] v2 保留了「无 query → 注入清单」分支，但两个调用点必然传非空 query，
//       且 goal 为空时按 P0-2 要求应返回空串——该分支既是死代码又与目标冲突。
// [CONSTRAINT] 检索失败回退为空串，绝不阻断首问；本模块无缓存（正文随查询变化，缓存无意义）。

import { log } from '../../utils/log'

export interface MatchedSkill {
  name: string
  path: string
  score: number
  matched: string[]
  body: string
}

/**
 * 按任务查询检索技能。
 * [WHY] 服务端 BM25 排序，客户端只负责发查询与拼装。
 * [CONSTRAINT] 查询为空 / 请求失败 → 返回空数组，绝不抛错阻断首问。
 * [CHANGE-IMPACT] limit 默认 3，与服务端 BODY_MAX_LINES 共同决定注入体积。
 * @param query 当前任务文本（通常是 goal）
 * @param limit 最多返回条数
 */
/**
 * [skill-match-meta-v1] 检索结果连同服务端下发的元信息一起返回。
 * [WHY] 服务端已下发 truncatedByBudget / appliedLimit，但客户端只取 matches ——
 *   用户无从知道「技能因体积预算被砍」，会误以为「只匹配到这几个」。
 * [CONSTRAINT] 失败时返回空 matches + truncated=false：与原有「失败即空」语义一致，
 *   调用方无需新增异常分支。
 */
export interface SkillMatchResult {
  matches: MatchedSkill[]
  /** 服务端因 TOTAL_MAX_CHARS 丢弃了尾部技能 */
  truncatedByBudget: boolean
  /** 服务端实际生效的 limit（可能被钳到上限） */
  appliedLimit: number
}

export async function matchSkills(query: string, limit = 3): Promise<SkillMatchResult> {
  const q = String(query || '').trim()
  const empty: SkillMatchResult = { matches: [], truncatedByBudget: false, appliedLimit: limit }
  if (!q) return empty
  try {
    const r = await fetch('/__ai/skills/match', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify({ query: q, limit }),
    })
    const j = await r.json()
    if (j && j.ok && Array.isArray(j.matches)) {
      return {
        matches: j.matches as MatchedSkill[],
        truncatedByBudget: j.truncatedByBudget === true,
        appliedLimit: Number(j.appliedLimit) || limit,
      }
    }
  } catch (e) {
    // [skill-match-visible-fail-v1] 原实现静默返回空数组：一次网络抖动就让本次首问永久失去技能注入，
    //   且首问标记照常置位（不再重试），用户只会觉得「技能好像没生效」而毫无信号。
    log.warn('[skill-registry] 技能检索失败，本次不注入技能', e)
  }
  return empty
}

/**
 * 拼装技能注入段落。
 * [WHY] 只走检索路径：无 query 或零命中一律返回空串，不注入清单。
 * [CONSTRAINT] 返回空串是正常路径（任务与技能无关时），调用方需容忍。
 * [CHANGE-IMPACT] 被 session-prompt.ts 的两个入口调用；返回值直接进入首问上下文。
 * @param query 当前任务文本；为空则不注入
 */
export async function buildSkillsBlock(query?: string): Promise<string> {
  const { matches, truncatedByBudget, appliedLimit } = await matchSkills(String(query || ''))
  if (!matches.length) return ''

  const parts = [
    '## 相关 Skills（按当前任务检索）',
    '',
    '以下技能与当前任务相关，已注入正文摘要。执行前若需完整内容，读取各自 path。',
  ]
  // [skill-match-meta-v1] 体积截断必须可见：否则用户以为「只匹配到这几个」，
  //   实际是「匹配到更多但装不下」。诚实告知比静默省略更有用。
  if (truncatedByBudget) {
    parts.push('', `> 注：命中数超过体积预算（上限 ${appliedLimit} 条），已按相关度保留前 ${matches.length} 条。`)
  }
  parts.push('')
  for (const m of matches) {
    parts.push(`### ${m.name}`, '', `- 路径: ${m.path}`, '', m.body, '')
  }
  return parts.join(String.fromCharCode(10))
}
