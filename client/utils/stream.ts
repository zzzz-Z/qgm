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
  } finally {
    try { reader.releaseLock() } catch { }
  }
}
