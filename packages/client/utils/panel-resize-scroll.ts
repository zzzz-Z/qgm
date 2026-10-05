// [panel-resize-scroll-v1] 面板尺寸变化时的 chat-list scrollTop 补偿
// [WHY] TaskProgressPanel 位于 chat-list 上方（flow-timeline 内）；
//   它从无到有（≤34vh 高度）会立即侵占 chat-list 的可用空间 → 视觉位置突变，
//   即使用户此前已贴底，看板出现瞬间也会“脱离贴底”。
// [CONSTRAINT] 纯函数，无 DOM 依赖；由 TerminalPane 在面板显隐时按 observed delta 调用
// @param currentScrollTop 当前 scrollTop
// @param deltaHeight 面板高度变化量（正=面板出现/变高，负=消失/变矮）
// @returns 补偿后的 scrollTop（下限 0）
export function computeCompensatedScrollTop(currentScrollTop: number, deltaHeight: number): number {
  if (!Number.isFinite(currentScrollTop)) return 0
  if (!Number.isFinite(deltaHeight)) return Math.max(0, currentScrollTop)
  return Math.max(0, currentScrollTop + deltaHeight)
}
