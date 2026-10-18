/**
 * [live-output-cap-v1] 流式输出累积的内存软上限。
 * [WHY] useRunner 的 liveStdout/liveStderr 直接 `+=` 追加，长任务（全量测试输出可达数 MB）
 *   会让前端内存单调增长；而这些内容在 UI 展示与 prompt 组装时都只用到尾部。
 * [CONSTRAINT] 按字符数而非字节数截断：目的是防数量级膨胀，不是精确限额；
 *   精确字节换算需每次追加都跑 TextEncoder，代价远大于收益。
 */
export const LIVE_OUTPUT_MAX_CHARS = 256 * 1024

/**
 * 追加文本并在超过上限时只保留尾部。
 * [CONSTRAINT] 只保留尾部：UI 展示与 prompt 组装都只关心最近的输出，
 *   历史部分由服务端 round 快照与日志承载（需要时用 readText 或查日志）。
 * @param target 形如 `{ value: string }` 的可写引用（Vue ref 或普通对象）
 * @param text 追加内容
 * @param maxChars 字符上限；默认 LIVE_OUTPUT_MAX_CHARS
 */
export function appendCapped(
  target: { value: string },
  text: string,
  maxChars: number = LIVE_OUTPUT_MAX_CHARS,
): void {
  const next = target.value + text
  target.value = next.length > maxChars ? next.slice(-maxChars) : next
}
