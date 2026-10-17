// @ts-nocheck
// [tampermonkey-ts-rewrite-v1] IIFE 物理切分片段，非独立模块；跨片段符号在单文件检查下不可见。
//   全部片段 TS 化完成、按拼回后的联合视图接线后再移除本 pragma。

/**
 * 围栏契约判定 —— 首行声明了 SCRIPT，但载荷不是合法 js/cjs 代码块时该怎么办。
 *
 * [WHY] 这类回复（正文里贴了伪代码、或用了非白名单语言标签）如果不报错就直接跳过，
 *   应用端只能看到「AI 说了话但工作台毫无反应」，属静默失败。
 *   但也不能每轮都报——AI 会持续流式改写，同一轮里报 N 次会刷屏。
 * [CONSTRAINT] 纯函数、无 DOM/闭包依赖，与 headless-inject.ts 的同名实现同构，
 *   由 script-fence-gate 守卫测试对拍。
 */

type FenceDecision = 'report' | 'suppress' | 'none'

/**
 * @param scriptMarkPositive 首行是否为 SCRIPT 标记
 * @param seenHashesLen 本轮已成功推送的脚本块数量
 * @param alreadyReported 本轮是否已报过错
 * [CONSTRAINT] seenHashesLen > 0 时一律 none：只要推成功过，就不是「载荷不合法」，
 *   而是正文里另有说明性内容，不该报错。
 */
function decideScriptFence(scriptMarkPositive: boolean, seenHashesLen: number, alreadyReported: boolean): FenceDecision {
  if (!scriptMarkPositive) return 'none'
  if (seenHashesLen > 0) return 'none'
  if (alreadyReported) return 'suppress'
  return 'report'
}
