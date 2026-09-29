// 会话提示词拼装：新会话首问需携带 SYSTEM.md + AGENTS.md + 上轮总结
// [WHY] 手写 DEFAULT_SESSION_PROMPT 与首问加载（useDeepseekUrl._prependFirstPromptRules）不同源，
//       超 200 轮自动轮转时会造成 AI 缺失完整规则；改为复用 preset/system + 工作区 AGENTS.md 双源。
// [CONSTRAINT] 两处 fetch 任一失败均降级到 DEFAULT_SESSION_PROMPT 兜底，绝不阻断新会话创建。
import { DEFAULT_SESSION_PROMPT } from './loopLogic.js'

/**
 * 拼装新会话首问提示词：SYSTEM.md + AGENTS.md + 上轮总结
 * [CHANGE-IMPACT] 被 handoff.ts / exec-flow.ts 调用；返回值经 sendNewSession 原样带到油猴侧
 * @param summary 上一轮会话总结
 */
export async function buildNewSessionPrompt(summary: string): Promise<string> {
  const parts: string[] = []
  try {
    const r = await fetch('/__ai/preset/system')
    const j = await r.json()
    if (j && j.ok && j.content) parts.push(`<file path="SYSTEM.md">` + `\n${j.content}\n</file>`)
  } catch { /* preset 不可用则跳过 */ }
  try {
    const r = await fetch('/__ai/files/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['AGENTS.md'] }),
    })
    const j = await r.json()
    const files = (j && j.files) || []
    for (const f of files) {
      if (!f || f.error || !f.content) continue
      parts.push(`<file path="${f.path}">` + `\n${f.content}\n</file>`)
    }
  } catch { /* 工作区读取失败则跳过 */ }
  if (!parts.length) return `${DEFAULT_SESSION_PROMPT}\n\n${summary}`
  return `${parts.join('\n\n')}\n\n# 上一轮会话总结\n\n${summary}`
}
