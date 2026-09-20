// [refactor-post-run] 从错误输出提取项目内源文件路径
import fs from 'node:fs'
import path from 'node:path'
import { getRoot } from '../config.js'
// 从错误输出里提取项目内的源文件路径。
// 支持 V8 / Node 常见栈格式：
//   at fn (/abs/path/file.ts:12:34)
//   /abs/path/file.ts:12:34
//   File "src/foo.ts", line 12
// ponytail: 只提取真实存在的文件，最多 5 个。够了。
export function extractErrorFiles(text: string): string[] {
  const out = new Set<string>()
  const re = /(?:\(|\s|^)((?:\/|[A-Za-z]:[\\/])?[\w./\\@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|vue))(?::\d+(?::\d+)?)?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    let p = m[1]
    if (p.includes('node_modules')) continue
    if (p.startsWith('node:')) continue
    // 绝对路径 → 项目相对路径
    if (path.isAbsolute(p)) {
      const rel = path.relative(getRoot(), p)
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue
      p = rel
    }
    // 只保留项目内真实文件
    const abs = path.join(getRoot(), p)
    if (!fs.existsSync(abs)) continue
    out.add(p.replace(/\\/g, '/'))
  }
  return [...out]
}
