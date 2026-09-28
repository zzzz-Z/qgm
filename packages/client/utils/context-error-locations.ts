// AIRUNNER-BATCH16-3-SPLIT-ERR-LOCS: 从 contextBuilder.ts 抽出的纯函数（parseErrorLocations）；无外部依赖

/**
 * 从错误文本中提取 文件→行号集合 映射
 * [WHY] 与 error-fingerprint 的语义定位互补：此处只关心"哪些行报错"，供 contextBuilder 决定局部渲染范围
 * [CONSTRAINT] 只匹配 .ts/.tsx/.js/.jsx/.mjs/.cjs/.vue；跳过 node_modules 与 node: 前缀；反斜杠规范化为正斜杠
 * [CHANGE-IMPACT] 返回 Map 键为 POSIX 路径，调用方需按同格式查找
 * @param text 原始错误输出（stderr / stdout）
 */
export function parseErrorLocations(text: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>()
  // AIRUNNER-BATCH16-3-FIX-CAPTURE-GROUP: 原 regex 首个捕获组是行号，导致 m[1] 拿错；补路径外层 ()
  // AIRUNNER-BATCH16-3-FIX-NODE-PREFIX: 补 optional node: 前缀，使内建模块能被 startsWith 判掉
  const re = /((?:node:)?(?:\/|[A-Za-z]:[\\/])?[\w./\\@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|vue)):(\d+)(?::\d+)?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const p = m[1].replace(/\\/g, '/')
    if (p.includes('node_modules')) continue
    if (p.startsWith('node:')) continue
    const n = Number(m[2])
    if (!Number.isFinite(n) || n <= 0) continue
    let set = out.get(p)
    if (!set) { set = new Set(); out.set(p, set) }
    set.add(n)
  }
  return out
}
