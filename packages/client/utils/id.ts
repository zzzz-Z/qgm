// [uid-v1] 统一 ID 生成：时间戳前缀（sortable）+ 随机后缀（唯一）。
// [WHY] 项目内 6 处重复 `Date.now().toString(36) + Math.random()`；且非安全上下文（http 局域网）
//        下 crypto.randomUUID 为 undefined 会白屏（报告 §2.13）。此处统一走三级回退。
// [CONSTRAINT] 返回 `${prefix}-${ts}-${rand}`；prefix 为空时返回 `${ts}-${rand}`。
// [CHANGE-IMPACT] 替换使用点后 id 形态与旧实现完全一致，历史持久化兼容。

/**
 * 生成稳定 ID
 * [WHY] 时间戳保证大致有序；随机后缀（8 hex 或 6 base36）避免同帧内碰撞
 * [CONSTRAINT] 无 crypto 时回落 Math.random，仍保持同一输出形态
 * @param prefix 可选前缀；空串时省略
 */
export function uid(prefix = ''): string {
  const ts = Date.now().toString(36)
  const c = (typeof crypto !== 'undefined' ? crypto : undefined) as Crypto | undefined
  let rand: string
  if (c && typeof c.randomUUID === 'function') {
    rand = c.randomUUID().slice(0, 8)
  } else if (c && typeof c.getRandomValues === 'function') {
    const buf = new Uint8Array(4)
    c.getRandomValues(buf)
    rand = ''
    for (const b of buf) rand += b.toString(16).padStart(2, '0')
  } else {
    rand = Math.random().toString(36).slice(2, 10)
  }
  return prefix ? `${prefix}-${ts}-${rand}` : `${ts}-${rand}`
}
