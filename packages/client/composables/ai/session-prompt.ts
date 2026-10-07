// 会话提示词拼装：新会话 / 循环首轮统一携带 SYSTEM.md + AGENTS.md
// [WHY] 所有下发提示词都由预设 SYSTEM.md + 工作区 AGENTS.md 拼装，与首问加载同源，
//       避免规则漂移；切工作区 / 超 200 轮轮转时 AI 上下文始终完整。
// [CONSTRAINT] 三处 fetch（SYSTEM/AGENTS、技能、lessons）任一失败 → 只返回业务内容
//             （goal），不注入其它兜底；三者失败时都降级为空串。
// [load-lessons-v1] lessons 注入：把既往踩坑记录带进决策回路（此前只被统计读，见 load-lessons.ts）
// [no-handoff-summary-v1] 新会话首问不再携带「上一轮总结」（见 buildNewSessionPrompt 注释）

// [load-rules-wired-v1] 读取逻辑已抽到 load-rules.ts（含 Promise 缓存）
import { loadRulesBlock } from './load-rules.js'
import { buildLessonsBlock } from './load-lessons.js'
import { buildSkillsBlock } from './skill-registry.js'

/**
 * 新会话首问：SYSTEM.md + AGENTS.md + 技能 + lessons + 目标
 * [CHANGE-IMPACT] 唯一调用方是 auto-loop/handoff.ts（onSummary）；返回值经 sendNewSession 原样带到接收侧
 * [lessons-inject-v2] 与 buildLoopInitialPrompt 对齐：交接后的新会话仍在做同一件事，
 *   既往踩坑记录同样相关
 * [query-source-v1] 技能检索用 query 而非正文：正文描述「已做」，用它推「将做」会
 *   把上一轮跑过的命令名当成需求（实测 goal 为空的 fallback 模板唯一可匹配词是 `test`，
 *   于是注入 tdd + systematic-debugging 共 6903 B，与目标无关）。query 缺省时退回正文。
 * [no-handoff-summary-v1] 不再搬运「上一轮会话总结」：交接正文不进入新会话首问。
 * [WHY] 交接正文（旧版为 AI 的 HANDOFF 总结）由页面 DOM 反推获得，一旦走到整页兜底
 *   （headless-inject.ts 的 `replyRoot = document`）就会把侧栏会话标题、问候语、
 *   输入区按钮文案一并抓进来；该路径返回 textContent，块级标签之间不插换行 ⇒ 整段黏成一行。
 *   于是新会话首问里出现一坨无法阅读的页面垃圾（实测 2026-10-07）。
 *   规则/技能/lessons 三块注入保持不变，只把「交接正文」换成原始目标。
 * @param goal 本次工作目标（循环的 goal）；不再接收上一轮总结
 * @param query 技能 / lessons 检索来源，缺省退回 goal
 */
export async function buildNewSessionPrompt(goal: string, query?: string): Promise<string> {
  const retrieval = String(query ?? goal ?? '').trim()
  const [rules, skills, lessons] = await Promise.all([loadRulesBlock(), buildSkillsBlock(retrieval), buildLessonsBlock(retrieval)])
  const head = [rules, skills, lessons].filter(Boolean).join('\n\n')

  const g = String(goal ?? '').trim() || '继续推进上一轮目标。'
  return head ? `${head}\n\n# 目标\n\n${g}` : g
}

/**
 * 循环首轮：SYSTEM.md + AGENTS.md + 目标
 * [CHANGE-IMPACT] 被 auto-loop/start-family.ts 调用；循环首轮的提示词入口
 * @param goal 用户填写的循环目标
 */
export async function buildLoopInitialPrompt(goal: string): Promise<string> {
  const [rules, skills, lessons] = await Promise.all([loadRulesBlock(), buildSkillsBlock(goal), buildLessonsBlock(goal)])
  const head = [rules, skills, lessons].filter(Boolean).join('\n\n')

  const g = String(goal).trim()
  return head ? `${head}\n\n# 目标\n\n${g}` : g
}
