// [refactor-post-run] shebang 分流：非 bash shebang 默认走 node

export interface ShebangSplit {
  isNodeScript: boolean
  effectiveScript: string
}

/** 判断脚本走 node 还是 shell，并在缺 node shebang 时自动补 */
export function splitShebang(script: string): ShebangSplit {
  const firstLine = script.split('\n', 1)[0].trim()
  const hasNodeShebang = /^#!\s*\/usr\/bin\/(?:env\s+)?node\b/.test(firstLine)
  const hasBashShebang = /^#!\s*(?:\/usr\/bin\/env\s+|\/bin\/|\/usr\/bin\/)?(?:bash|sh|zsh)\b/.test(firstLine)
  const isNodeScript = hasNodeShebang || !hasBashShebang
  const effectiveScript = isNodeScript && !hasNodeShebang ? (`#!/usr/bin/env node\n${script}`) : script
  return { isNodeScript, effectiveScript }
}
