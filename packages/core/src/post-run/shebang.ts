// shebang 分流：JS-Only 唯一通道（[g2-narrow-v1] G2 收窄）
// 非 node shebang 的脚本由 routes/run.ts 前置的 scanScriptHead 拦截；
// 本函数一律返回 isNodeScript:true，不再走 shell 通道。

/** shebang 分流结果：是否为 node 脚本 + 补全后的脚本内容 */
export interface ShebangSplit {
  isNodeScript: boolean
  effectiveScript: string
}

/** 判断脚本是否需要补 node shebang（非 node shebang 由上层拦截） */

/**
 * 分离脚本的 shebang 行与主体（含缺失 shebang 时补齐）
 * [WHY] 执行前需保证 cjs 脚本以 node shebang 开头，否则 node 会按默认解析报错
 * [CONSTRAINT] G2 收窄后 isNodeScript 恒 true（禁用 bash 分流）；缺 shebang 时自动补 node 头
 * [CHANGE-IMPACT] 返回 effectiveScript 会被真正写入磁盘执行；修改补头逻辑需同步 run-script 的脚本头契约校验
 * @param script 用户 / AI 提交的脚本原文
 */
export function splitShebang(script: string): ShebangSplit {
  const firstLine = script.split('\n', 1)[0].trim()
  const startsWithShebang = firstLine.startsWith('#!')
  const isNodeScript = true // [G2] 收窄：禁止 bash 分流
  const effectiveScript = startsWithShebang ? script : (`#!/usr/bin/env node\n${script}`)
  return { isNodeScript, effectiveScript }
}
