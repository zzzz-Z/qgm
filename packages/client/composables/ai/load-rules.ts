// [load-rules-v1] 读 SYSTEM.md + AGENTS.md 拼成 <file> 块的公共逻辑。
// [WHY] session-prompt.ts 与 useAiWindow.ts 各自实现一遍，逐字重复；抽象后同源且可缓存。
// [CONSTRAINT] SYSTEM.md 走 /__ai/preset/system（不读工作区），AGENTS.md 走 /__ai/files/read；
//             任一失败降级为空串，不阻断调用方。
// [CHANGE-IMPACT] 缓存 Promise（非值）：同会话内多次调用共享同一次网络往返；失败时缓存不写入，下次可重试。

interface RulesParts {
  systemPart: string
  agentsParts: string[]
}

// [rules-promise-cache-v1] 单次会话内 SYSTEM.md / AGENTS.md 内容视为稳定；
// 缓存 in-flight Promise 避免并发首问重复请求；失败时不缓存，允许后续重试。
let _rulesPromise: Promise<RulesParts> | null = null

/** 清空缓存（工作区切换 / 强制刷新时调用） */
export function clearRulesCache(): void {
  _rulesPromise = null
}

/**
 * 并行读 SYSTEM.md 与 AGENTS.md，返回已拆分好的两部分
 * [WHY] 调用方拼装方式不同（session-prompt 拼业务上下文；useAiWindow 拼首问 prompt），故返回结构化结果。
 */
export function loadRulesParts(): Promise<RulesParts> {
  if (_rulesPromise) return _rulesPromise
  _rulesPromise = (async (): Promise<RulesParts> => {
    const [systemPart, agentsParts] = await Promise.all([
      (async (): Promise<string> => {
        try {
          const r = await fetch('/__ai/preset/system')
          const j = await r.json()
          if (j && j.ok && j.content) return `<file path="SYSTEM.md">` + `\n${j.content}\n</file>`
        } catch { /* preset 不可用 */ }
        return ''
      })(),
      (async (): Promise<string[]> => {
        try {
          const r = await fetch('/__ai/files/read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths: ['AGENTS.md'] }),
          })
          const j = await r.json()
          const files = (j && j.files) || []
          const out: string[] = []
          for (const f of files) {
            if (!f || f.error || !f.content) continue
            out.push(`<file path="${f.path}">` + `\n${f.content}\n</file>`)
          }
          return out
        } catch { return [] }
      })(),
    ])
    return { systemPart, agentsParts }
  })()
  // 失败不缓存（保留重试机会）；成功由调用方自然消费
  _rulesPromise.catch(() => { _rulesPromise = null })
  return _rulesPromise
}

/** 便捷：拼成 `<file>...</file>` 块的纯文本（SYSTEM 在前，AGENTS 依次追加） */
export async function loadRulesBlock(): Promise<string> {
  const { systemPart, agentsParts } = await loadRulesParts()
  const parts: string[] = []
  if (systemPart) parts.push(systemPart)
  parts.push(...agentsParts)
  return parts.join('\n\n')
}
