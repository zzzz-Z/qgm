// [first-prompt-rules-v1] 会话首问的规则头拼装：rules + skills + lessons。
// [WHY] 从 useAiWindow._prependFirstPromptRules 抽出（P3d）：它是「读三块 + 拼 <file> 块」的
//   独立职责；抽出后 sessionPromptLessons.node-test.ts 的 4 组守卫（注入对齐 / 状态图例 /
//   窗口卫生 / 预算封顶）有了稳定被测对象，不会随 auto-loop 目录删除而失去覆盖。
// [CONSTRAINT] 三块任一失败降级为空串（与 load-rules / load-lessons / skill-registry 的约定一致）；
//   整块为空时返回原 prompt，不注入空壳。
import { buildLessonsBlock } from './load-lessons.js'
import { loadRulesBlock } from './load-rules.js'
import { buildSkillsBlock } from './skill-registry.js'

/**
 * 在 prompt 前拼「# 会话首问规则（自动携带）」块。
 * [CONSTRAINT] 幂等：prompt 已含 `<file path="SYSTEM.md">` 时原样返回。
 * @param prompt 用户原始输入（同时作为 skills / lessons 的检索 query）
 * @returns 拼好规则头的 prompt；三块全空时返回原 prompt
 */
export async function prependFirstPromptRules(prompt: string): Promise<string> {
  if (prompt.includes('<file path="SYSTEM.md">')) return prompt
  try {
    const [rules, skills, lessons] = await Promise.all([
      loadRulesBlock(),
      buildSkillsBlock(prompt),
      buildLessonsBlock(prompt),
    ])
    const block = [rules, skills, lessons].filter(Boolean).join('\n\n')
    if (!block) return prompt
    return `# 会话首问规则（自动携带）\n\n${block}\n\n# 问题\n\n${prompt}`
  } catch {
    return prompt
  }
}
