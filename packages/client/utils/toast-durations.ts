// [toast-durations-v1] toast 显示时长集中定义。
// [WHY] 全仓 79 处硬编码时长（4000ms 出现 25 次）；集中后视觉反馈节奏可整体调整。
// [CONSTRAINT] 值语义：毫秒；命名按用途而非具体数值，调参时调用方无需改。

/** 极短：复制成功 / 状态切换的瞬时反馈 */
export const TOAST_FAST = 1500
/** 短：常规操作成功提示 */
export const TOAST_SHORT = 2000
/** 默认：一般信息提示 */
export const TOAST_DEFAULT = 3000
/** 中：需要用户注意的警告 */
export const TOAST_MEDIUM = 4000
/** 长：错误提示，给用户阅读时间 */
export const TOAST_LONG = 6000
/** 极长：关键信息（存档 commit 哈希、登录指引） */
export const TOAST_LONGEST = 8000
/** 较长：重要操作（回滚、会话切换） */
export const TOAST_VERY_LONG = 5000
/** 中短：需要留意但无需长读 */
export const TOAST_MEDIUM_SHORT = 3500
/** 中短：状态反馈（结束循环） */
export const TOAST_SHORT_MEDIUM = 2500
