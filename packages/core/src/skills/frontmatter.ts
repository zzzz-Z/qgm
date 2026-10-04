// [skill-frontmatter-v1] SKILL.md 的 YAML frontmatter 最小解析器（零依赖手写子集）。
// [WHY] 从 routes/skills.ts 抽出为独立模块：安装侧（skills/installer.ts）要在落盘前校验远端
//   frontmatter 是否合规，而 routes 层不该被反向 import（routes/skills.ts → installer.ts →
//   routes/skills.ts 会成环）。routes/skills.ts 改为 re-export，既有测试导入路径不变。
// [CONSTRAINT] 不追求完整 YAML；块标量只处理缩进续行，不支持锚点/引用。解析失败返回 null，不抛错。
// [CHANGE-IMPACT] 被 GET /skills、POST /skills/match 与安装侧校验共用；解析行为改变会影响召回面。

const FRONTMATTER_SCAN_LINES = 64

/** 去掉 YAML 标量两端成对的单/双引号 */
export function unquote(v: string): string {
  if (v.length >= 2) {
    const a = v[0]
    const b = v[v.length - 1]
    if ((a === '"' && b === '"') || (a === '\'' && b === '\'')) return v.slice(1, -1)
  }
  return v
}

/**
 * 解析 YAML frontmatter 的 name/description；缺任一项返回 null。
 * [frontmatter-robust-v1] 支持块标量（>/|）与带引号的 key。旧实现只认单行 key: value，
 *   遇到这两种合法写法会静默失效——review 实测：description 用 > 折叠块时值为 ">"，
 *   tokenize 后零 token 导致该技能永远召回不到；key 加引号时整条从清单与检索同时消失。
 */
export function parseFrontmatter(text: string): { name: string, description: string, keywords?: string } | null {
  const lines = text.split(/\r?\n/)
  if (!lines[0] || lines[0].trim() !== '---') return null
  const upper = Math.min(lines.length, FRONTMATTER_SCAN_LINES)
  let end = -1
  for (let i = 1; i < upper; i++) {
    if (lines[i].trim() === '---') { end = i; break }
  }
  if (end < 0) return null
  const meta: Record<string, string> = {}
  for (let i = 1; i < end; i++) {
    const raw = lines[i]
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue
    const idx = raw.indexOf(':')
    if (idx < 0) continue
    const key = unquote(raw.slice(0, idx).trim())
    if (!/^[\w-]+$/.test(key)) continue
    const inline = raw.slice(idx + 1).trim()
    if (inline === '>' || inline === '|' || inline === '>-' || inline === '|-') {
      const baseIndent = raw.length - raw.trimStart().length
      const parts: string[] = []
      let j = i + 1
      for (; j < end; j++) {
        const cur = lines[j]
        if (!cur.trim()) { parts.push(''); continue }
        const ind = cur.length - cur.trimStart().length
        if (ind <= baseIndent) break
        parts.push(cur.trim())
      }
      i = j - 1
      const joined = inline.startsWith('|') ? parts.join('\n') : parts.join(' ').replace(/\s+/g, ' ')
      meta[key] = joined.trim()
      continue
    }
    meta[key] = unquote(inline)
  }
  if (meta.name && meta.description) return { name: meta.name, description: meta.description, keywords: meta.keywords || undefined }
  return null
}
