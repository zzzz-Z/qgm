// [limit-toast-quote-v1] 触顶 toast 的文案组装（从 useAiReplyHandlers 抽出，便于裸测）。
// [WHY] 页面侧探针把命中的**原文**放在 payload.text 里（油猴 `limitMarkerText`、
//       headless `limitMessages[last]`），但客户端此前丢弃它、只弹固定文案 ⇒
//       误报（页面根本没有触顶 banner）时无从定位是哪段 DOM 文本命中了正则。
//       2026-10-07 实测：正则第 4 分支 `(?:对话|会话|上下文)(?:长度)?\s*(?:上限|最大长度|过长)
//       [，,：:]?\s*请?(?:开启|开始|新建|创建)(?:一个)?新(?:对话|会话)` 允许「请」缺省，
//       而 DeepSeek 侧栏常驻按钮就是「开启新对话」⇒ 页面上任意以「对话长度上限」结尾的文本
//       与它拼接即假命中（探针：'本模型对话长度上限开启新对话' 命中）。
// [CONSTRAINT] 命中串只作诊断信息：截断 + 折叠空白，避免 run-on 全页文本把 toast 撑爆。
const GENERIC = 'AI 会话已达长度上限'
const QUOTE_MAX = 40

/** 把页面侧命中原文折叠成适合单行 toast 的短串 */
export function normalizeLimitHit(raw: unknown): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * 组装触顶 toast 文案：命中串可辨识时附上，便于事后定位误报源。
 * 命中串为空、或与通用文案本身相同（页面侧兜底值）时不加括号，避免自指噪音。
 */
export function formatLimitToast(raw: unknown): string {
  const hit = normalizeLimitHit(raw)
  if (!hit || hit === GENERIC) return GENERIC
  const shown = hit.length > QUOTE_MAX ? `${hit.slice(0, QUOTE_MAX)}…` : hit
  return `${GENERIC}（页面命中：${shown}）`
}

export const LIMIT_TOAST_GENERIC = GENERIC
