// 会话提示词拼装：新会话 / 循环首轮统一携带 SYSTEM.md + AGENTS.md
// [WHY] 所有下发提示词都由预设 SYSTEM.md + 工作区 AGENTS.md 拼装，与首问加载同源，
//       避免规则漂移；切工作区 / 超 200 轮轮转时 AI 上下文始终完整。
// [CONSTRAINT] 三处 fetch（SYSTEM/AGENTS、技能、lessons）任一失败 → 只返回业务内容
//             （summary / goal），不注入其它兜底；三者失败时都降级为空串。
// [load-lessons-v1] lessons 注入：把既往踩坑记录带进决策回路（此前只被统计读，见 load-lessons.ts）

// [load-rules-wired-v1] 读取逻辑已抽到 load-rules.ts（含 Promise 缓存）
import { loadRulesBlock } from './load-rules.js'
import { buildLessonsBlock } from './load-lessons.js'
import { buildSkillsBlock } from './skill-registry.js'

/**
 * 新会话首问：SYSTEM.md + AGENTS.md + 技能 + lessons + 上一轮总结
 * [CHANGE-IMPACT] 被 handoff.ts / exec-flow.ts 调用；返回值经 sendNewSession 原样带到油猴侧
 * [lessons-inject-v2] 与 buildLoopInitialPrompt 对齐：交接后的新会话仍在做同一件事，
 *   既往踩坑记录同样相关（唯一调用方是 auto-loop/handoff.ts，见该处 onSummary）
 * [query-source-v1] 技能检索用 query 而非 summary：summary 描述「已做」，用它推「将做」会
 *   把上一轮跑过的命令名当成需求（实测 goal 为空的 fallback 模板唯一可匹配词是 `test`，
 *   于是注入 tdd + systematic-debugging 共 6903 B，与目标无关）。query 缺省时退回 summary。
 * @param summary 上一轮会话总结（仅作正文，不作检索依据）
 * @param query 技能检索来源，通常是 goal；为空则不检索
 */
export async function buildNewSessionPrompt(summary: string, query?: string): Promise<string> {
  const retrieval = String(query ?? summary ?? '').trim()
  const [rules, skills, lessons] = await Promise.all([loadRulesBlock(), buildSkillsBlock(retrieval), buildLessonsBlock()])
  const head = [rules, skills, lessons].filter(Boolean).join('\n\n')

  return head ? `${head}\n\n# 上一轮会话总结\n\n${summary}` : summary
}

/**
 * 循环首轮：SYSTEM.md + AGENTS.md + 目标
 * [CHANGE-IMPACT] 被 auto-loop/start-family.ts 调用；循环首轮的提示词入口
 * @param goal 用户填写的循环目标
 */
export async function buildLoopInitialPrompt(goal: string): Promise<string> {
  const [rules, skills, lessons] = await Promise.all([loadRulesBlock(), buildSkillsBlock(goal), buildLessonsBlock()])
  const head = [rules, skills, lessons].filter(Boolean).join('\n\n')

  const g = String(goal).trim()
  return head ? `${head}\n\n# 目标\n\n${g}` : g
}
