// 规则文件 hash 计算（compliance 分组用）
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

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
    const baseDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../skills')
    const userDir = path.join(getRoot(), '.ai-runner/skills')
    const files: string[] = []
    for (const dir of [baseDir, userDir]) {
      if (!fs.existsSync(dir)) continue
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.md')) files.push(path.join(dir, f))
      }
    }
    files.sort()
    const content = files.map((f) => {
      try { return fs.readFileSync(f, 'utf8') } catch { return '' }
    }).join('\n---\n')
    _rulesHashCache = crypto.createHash('sha256').update(content).digest('hex').slice(0, 8)
    return _rulesHashCache
  } catch { return 'unknown' }
}
