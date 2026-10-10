// [load-rules-v1] 读 SYSTEM.md + AGENTS.md 拼成 <file> 块的公共逻辑。
// [WHY] session-prompt.ts 与 useAiWindow.ts 各自实现一遍，逐字重复；抽象后同源且可缓存。
// [CONSTRAINT] SYSTEM.md 走 /__ai/preset/system（不读工作区），AGENTS.md 走 /__ai/files/read；
//             任一失败 → 空串占位，不阻断调用方（会话仍可发出，仅缺规则头）。
// [CHANGE-IMPACT] 缓存 Promise（非值）：同会话内多次调用共享同一次网络往返；
//             任一分支失败时**不缓存**（下次重试），成功才留缓存。

import { log } from '../../utils/log'

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
 * [empty-cache-fix-v1] 关键约束：SYSTEM.md 加载失败时**必须清缓存**，否则启动早期一次失败
 *   会被永久缓存（旧实现 catch 内 return '' → 外层 resolve → .catch 不触发），
 *   本标签页内后续所有新会话/循环首轮都拿不到规则——这是「打开新会话窗口不加载系统提示词」的根因。
 *   [CONSTRAINT] 调用方（session-prompt.ts / useAiWindow.ts）无兜底 try/catch，故此函数不得 reject；
 *   失败时返回降级结果（systemPart=''）并由内部清缓存，调用方语义不变。
 */
export function loadRulesParts(): Promise<RulesParts> {
  if (_rulesPromise) return _rulesPromise

  const systemFailed = { value: false }
  const agentsFailed = { value: false }

  _rulesPromise = (async (): Promise<RulesParts> => {
    const [systemPart, agentsParts] = await Promise.all([
      (async (): Promise<string> => {
        try {
          const r = await fetch('/__ai/preset/system')
          if (!r.ok) throw new Error(`preset/system HTTP ${r.status}`)
          const j = await r.json()
          if (!j || !j.ok || !j.content) throw new Error('preset SYSTEM.md unavailable')
          return `<file path="SYSTEM.md">` + `\n${j.content}\n</file>`
        } catch (e) {
          systemFailed.value = true
          log.warn('[load-rules] SYSTEM.md 加载失败，本次结果不缓存，下次重试', e)
          return ''
        }
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
          for (const fileEntry of files) {
            if (!fileEntry || fileEntry.error || !fileEntry.content) continue
            out.push(`<file path="${fileEntry.path}">` + `\n${fileEntry.content}\n</file>`)
          }
          return out
        } catch (e) {
          agentsFailed.value = true
          log.warn('[load-rules] AGENTS.md 加载失败，本次结果不缓存，下次重试', e)
          return []
        }
      })(),
    ])
    return { systemPart, agentsParts }
  })()

  // [empty-cache-fix-v1] 任一分支失败 → 清缓存（保留重试机会）；二者都成功才留缓存
  void _rulesPromise.then(() => {
    if (systemFailed.value || agentsFailed.value) _rulesPromise = null
  }).catch(() => { _rulesPromise = null })

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
