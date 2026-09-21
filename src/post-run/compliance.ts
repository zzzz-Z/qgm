// 规则文件 hash 计算（compliance 分组用）
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { getRoot } from '../config.js'
// [A13] 规则文件 hash：让 compliance 报告可按规则版本分组
let _rulesHashCache: string | null = null
// skills 变更后清缓存
export function clearRulesHashCache() { _rulesHashCache = null }
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
