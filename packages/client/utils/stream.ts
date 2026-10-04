/**
 * 逐行解析 NDJSON 流并回调每一帧
 * [WHY] 服务端 /__ai/run 返回 NDJSON（每行一个 JSON 对象）；此工具收敛流式解析细节
 * [CONSTRAINT] 依赖 stream:true 解码处理跨 chunk 的多字节字符；
 * 行末无换行的尾帧在流关闭时会被丢弃（服务端需保证最后一帧带换行）
 * [CHANGE-IMPACT] 被 useRunner 消费；回调抛错会中断整个流的读取
 * @param body HTTP 响应的 ReadableStream
 * @param onFrame 每解析出一帧时回调
 * @param signal 可选 AbortSignal；aborted 时提前跳出读取循环
 */
export async function readNdjson<T>(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: T) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader()
  const dec = new TextDecoder('utf8')
  let buf = ''
  try {
    while (true) {
      if (signal?.aborted) break
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        let frame: T
        try { frame = JSON.parse(line) as T } catch { continue }
        onFrame(frame)
      }
    }
    // [stream-flush-v1] 报告 §3 P2：末次 decode 未 flush，多字节残留会丢末帧
    buf += dec.decode()
    const tail = buf.trim()
    if (tail) {
      try { onFrame(JSON.parse(tail) as T) } catch { /* 尾帧解析失败忽略 */ }
    }
  } finally {
    // [stream-cancel-v1] 报告 §3 P2：原只 releaseLock，底层流仍在传输；主动 cancel 释放
    try { await reader.cancel() } catch { /* 流已关闭 */ }
    try { reader.releaseLock() } catch { /* swallow: 流已关闭 / 已释放，releaseLock 幂等性不保证 */ }
  }
}
