// @ts-nocheck
// [tampermonkey-ts-rewrite-v1] IIFE 物理切分片段，非独立模块；跨片段符号在单文件检查下不可见。
//   全部片段 TS 化完成、按拼回后的联合视图接线后再移除本 pragma。

/**
 * 回复内容的稳定指纹（FNV-1a 32bit），用于脚本块 / DONE 标记去重。
 * [WHY] 不用 JSON.stringify 或 length：同长度不同内容的块必须区分，否则流式改写会漏推。
 * [CONSTRAINT] 与 headless-inject.ts 的同名实现必须同值——两通道对同一回复算出不同 hash
 *   会让「已推送」判定分叉，表现为同一条回复被推两次。
 */
function hash32(s: string): string {
  let h = 0x811C9DC5
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x1000193) >>> 0
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}
