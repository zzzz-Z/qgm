// [skill-registry-v3] 按任务检索技能正文；空 query 不注入任何内容
// [WHY] v2 保留了「无 query → 注入清单」分支，但两个调用点必然传非空 query，
//       且 goal 为空时按 P0-2 要求应返回空串——该分支既是死代码又与目标冲突。
// [CONSTRAINT] 检索失败回退为空串，绝不阻断首问；本模块无缓存（正文随查询变化，缓存无意义）。

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
export async function matchSkills(query: string, limit = 3): Promise<MatchedSkill[]> {
  const q = String(query || '').trim()
  if (!q) return []
  try {
    const r = await fetch('/__ai/skills/match', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify({ query: q, limit }),
    })
    const j = await r.json()
    if (j && j.ok && Array.isArray(j.matches)) return j.matches as MatchedSkill[]
  } catch { /* 检索不可用 → 退回无技能注入 */ }
  return []
}

/**
 * 拼装技能注入段落。
 * [WHY] 只走检索路径：无 query 或零命中一律返回空串，不注入清单。
 * [CONSTRAINT] 返回空串是正常路径（任务与技能无关时），调用方需容忍。
 * [CHANGE-IMPACT] 被 session-prompt.ts 的两个入口调用；返回值直接进入首问上下文。
 * @param query 当前任务文本；为空则不注入
 */
export async function buildSkillsBlock(query?: string): Promise<string> {
  const matched = await matchSkills(String(query || ''))
  if (!matched.length) return ''

  const parts = [
    '## 相关 Skills（按当前任务检索）',
    '',
    '以下技能与当前任务相关，已注入正文摘要。执行前若需完整内容，读取各自 path。',
    '',
  ]
  for (const m of matched) {
    parts.push(`### ${m.name}`, '', `- 路径: ${m.path}`, '', m.body, '')
  }
  return parts.join(String.fromCharCode(10))
}
