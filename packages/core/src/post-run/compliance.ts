// 规则文件 hash 计算（compliance 分组用）
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// [A13] 规则文件 hash：让 compliance 报告可按规则版本分组
let _rulesHashCache: string | null = null
// AIRUNNER-BATCH10-7-INLINE-ROOT: 内联 root 派生，解除 config.js 依赖（strip-types 可加载）

/**
 * 获取 Root
 */
function getRoot(): string {
  return process.env.AI_RUNNER_ROOT || process.env.AIR_ROOT || process.cwd()
}// skills 变更后清缓存
/**
 * 清空 Rules Hash Cache
 */
export function clearRulesHashCache() { _rulesHashCache = null }
/**
 * 计算哈希值 Rules
 */
export function hashRules(): string {
  if (_rulesHashCache !== null) return _rulesHashCache
  try {
    // [rules-hash-v2] SSOT 是 SYSTEM.md；skills 目录作为补充参与 hash
    // [WHY] 原实现只读 .ai-runner/skills（目录不存在）→ 恒返回 sha256('')=e3b0c442，分组失效
    // [CHANGE-IMPACT] compliance.jsonl 的 rulesHash 会从 e3b0c442 变为 SYSTEM.md 内容哈希
    const sources: string[] = []
    const sysPath = path.join(getRoot(), 'packages/core/SYSTEM.md')
    if (fs.existsSync(sysPath)) sources.push(sysPath)
    const userDir = path.join(getRoot(), '.ai-runner/skills')
    if (fs.existsSync(userDir)) {
      for (const f of fs.readdirSync(userDir)) {
        if (f.endsWith('.md')) sources.push(path.join(userDir, f))
      }
    }
    sources.sort()
    const content = sources.map((f) => {
      try { return fs.readFileSync(f, 'utf8') } catch { return '' }
    }).join('\n---\n')
    _rulesHashCache = crypto.createHash('sha256').update(content).digest('hex').slice(0, 8)
    return _rulesHashCache
  } catch { return 'unknown' }
}
