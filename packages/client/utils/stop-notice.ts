// [stopped-toast-quote-v1] 停止类 toast 的文案组装（从 useAiReplyHandlers 抽出，便于裸测）。
// [WHY] 页面侧停止探针此前上报的是**写死文案**，命中的原文被丢掉（对比触顶：那边早已带上
//   `limitMarkerText`） ⇒ 2026-10-10 14:14 那次停止类自指误报**无法自证**命中了什么，
//   只能靠 arrive/send 日志旁证。改为与触顶同一范式：回显页面命中原文 + 折叠空白 + 截断。
// [CONSTRAINT] **停机态整句不得连写**。理由与前几条自指教训同源：三个停机态就写在停止探针的正则里，
//   若我们自己的 UI 文案与之同形，则源码一旦被 dump 进会话（`readText` / patch 失败回显 nearLines /
//   AI 行文复述），它就变成页面**普通文本**（不在 `<pre><code>` 内，剥壳与围栏都拦不住），
//   被自身探针当成站点给出的「停止」横幅 ⇒ 误报并掐掉一整轮（2026-10-10 14:14 实测）。
//   故一律**分段拼接**，对外**呈现逐字不变**（用户看到的仍是同一句话）。
// [CONSTRAINT] 命中串只作诊断信息：截断 + 折叠空白，避免 run-on 全页文本把 toast 撑爆。
const HEAD = 'AI 网页'
const STOPWORD = '已停止' + '生成'
const QUOTE_MAX = 40

/** 停止类提示的公共抬头（分段拼接，理由见文件头 [CONSTRAINT]） */
export const STOPPED_HEAD = `${HEAD}${STOPWORD}`
/** 停止后到达的脚本只回填编辑器、不自动执行 —— 抬头后的固定提示尾 */
export const STOPPED_SCRIPT_HINT = `${STOPPED_HEAD}：脚本仅回填编辑器，未自动执行（确认无误请手动运行）`

/** 停止分支的通用 toast 文案（页面侧未给出命中原文时的兜底） */
export const STOPPED_TOAST_GENERIC = `${STOPPED_HEAD}，本轮不再等待`

/** 把页面侧命中原文折叠成适合单行 toast 的短串 */
export function normalizeStopHit(raw: unknown): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * 组装停止 toast 文案：命中串可辨识时附上，便于事后定位误报源。
 * 命中串为空、或与通用文案本身相同（页面侧兜底值）时不加括号，避免自指噪音。
 */
export function formatStopToast(raw: unknown): string {
  const hit = normalizeStopHit(raw)
  if (!hit || hit === STOPPED_TOAST_GENERIC) return STOPPED_TOAST_GENERIC
  const shown = hit.length > QUOTE_MAX ? `${hit.slice(0, QUOTE_MAX)}…` : hit
  return `${STOPPED_TOAST_GENERIC}（页面命中：${shown}）`
}
