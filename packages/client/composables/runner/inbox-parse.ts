// AIRUNNER-BATCH5-0C-INBOX-LOGIC: 从 useScriptInbox.ts 抽出的纯函数（无外部依赖）
// normalizeForHash: 用于 push 去重指纹；parseMeta: 解析 AI 回复首部 @desc/@why 元注释

/**
 * 归一化脚本内容，用于 push 去重指纹
 * [WHY] 剔除 shebang / 注释 / 空白后比较，避免仅元信息变化被判为新脚本
 * [CONSTRAINT] 只去行首 shebang 与单行注释；不剥离多行块注释
 * [CHANGE-IMPACT] 输出被 useScriptInbox 用作 Set 键；改归一规则会让历史去重失效（重新接受旧脚本）
 * @param code 原始脚本内容；null / undefined 会按空串处理
 */
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

/**
 * 从脚本首部提取 @desc / @why 元注释（多行匹配，各取首个非空）
 * [WHY] 脚本头契约（SYSTEM.md §1.4）要求首部带这两条；解析失败时降级为空串不阻断
 * [CONSTRAINT] js/cjs 用 // 前缀、bash 用 # 前缀；desc / why 值截断至 200 字符
 * [CHANGE-IMPACT] 返回结构被 useRunner / run.ts 的 scriptDesc / scriptWhy 消费
 * @param lang 目标语言，决定注释前缀
 */
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
