// shebang 分流：SYSTEM.md §一 JS-Only 唯一通道（[g2-narrow-v1] G2 收窄）
// 非 node shebang 的脚本由 routes/run.ts 前置的 scanScriptHead (§1.4) 拦截；
// 本函数一律返回 isNodeScript:true，不再走 shell 通道。

/** shebang 分流结果：是否为 node 脚本 + 补全后的脚本内容 */
export interface ShebangSplit {
  isNodeScript: boolean
  effectiveScript: string
}

/** 判断脚本是否需要补 node shebang（非 node shebang 由上层拦截） */

/**
 * 切分 Shebang
 * @param script - script
 */
export function splitShebang(script: string): ShebangSplit {
  const firstLine = script.split('\n', 1)[0].trim()
  const startsWithShebang = firstLine.startsWith('#!')
  const isNodeScript = true // [G2] 收窄：禁止 bash 分流
  const effectiveScript = startsWithShebang ? script : (`#!/usr/bin/env node\n${script}`)
  return { isNodeScript, effectiveScript }
}
