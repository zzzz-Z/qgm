// 会话提示词拼装：新会话 / 循环首轮统一携带 SYSTEM.md + AGENTS.md
// [WHY] 手写契约（原 loopLogic CONTRACT_LINES / DEFAULT_SESSION_PROMPT）与首问加载不同源，
//       切工作区 / 超 200 轮轮转时会造成 AI 缺失完整规则；统一从预设 SYSTEM.md + 工作区 AGENTS.md 拼装。
// [CONSTRAINT] 两处 fetch 任一失败 → 只返回业务内容（summary / goal），不注入任何手写契约；
//             fetch 指向同源 HTTP 服务，失败极罕见，不做重复手写兜底。

/** 读 SYSTEM.md（预设源）与 AGENTS.md（工作区）包成 <file> 块；任一失败返回空串 */
async function loadRulesBlock(): Promise<string> {
  const parts: string[] = []
  try {
    const r = await fetch('/__ai/preset/system')
    const j = await r.json()
    if (j && j.ok && j.content) parts.push(`<file path="SYSTEM.md">` + `\n${j.content}\n</file>`)
  } catch { /* preset 不可用 */ }
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
  } catch { /* 工作区读取失败 */ }
  return parts.join('\n\n')
}

/**
 * 新会话首问：SYSTEM.md + AGENTS.md + 上一轮总结
 * [CHANGE-IMPACT] 被 handoff.ts / exec-flow.ts 调用；返回值经 sendNewSession 原样带到油猴侧
 * @param summary 上一轮会话总结
 */
export async function buildNewSessionPrompt(summary: string): Promise<string> {
  const rules = await loadRulesBlock()
  return rules ? `${rules}\n\n# 上一轮会话总结\n\n${summary}` : summary
}

/**
 * 循环首轮：SYSTEM.md + AGENTS.md + 目标
 * [CHANGE-IMPACT] 被 auto-loop/start-family.ts 调用；替换原 loopLogic.buildInitialPrompt
 * @param goal 用户填写的循环目标
 */
export async function buildLoopInitialPrompt(goal: string): Promise<string> {
  const rules = await loadRulesBlock()
  const g = String(goal).trim()
  return rules ? `${rules}\n\n# 目标\n\n${g}` : g
}
