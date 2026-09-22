// AIRUNNER-BATCH5-0C-INBOX-LOGIC: 从 useScriptInbox.ts 抽出的纯函数（无外部依赖）
// normalizeForHash: 用于 push 去重指纹；parseMeta: 解析 AI 回复首部 @desc/@why 元注释

export function normalizeForHash(code: string): string {
  return String(code ?? '')
    .split('\n')
    .map(l => l.trim())
    .filter((l) => {
      if (!l) return false
      // shebang 行
      if (l.startsWith('#!')) return false
      // cjs/js 注释
      if (l.startsWith('//')) return false
      // bash 注释（也覆盖 #!）
      if (l.startsWith('#')) return false
      return true
    })
    .map(l => l.replace(/\s+/g, ''))
    .join('')
}

export function parseMeta(code: string, lang: 'js' | 'cjs' | 'bash'): { desc: string, why: string } {
  const out = { desc: '', why: '' }
  const re = (lang === 'cjs' || lang === 'js')
    ? /^[^\S\n]*\/\/[^\S\n]*@(desc|why)[^\S\n]*:[^\S\n]*(\S[^\n]*)$/gm
    : /^[^\S\n]*#[^\S\n]*@(desc|why)[^\S\n]*:[^\S\n]*(\S[^\n]*)$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) {
    const k = m[1] === 'desc' ? 'desc' : 'why'
    if (!out[k]) out[k] = m[2].trim().slice(0, 200)
  }
  return out
}
