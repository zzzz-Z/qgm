// [refactor-post-run] 沙盒内 fs 工具调用日志读取
import fs from 'node:fs'

export interface ToolCall {
  op: string
  path: string
  size: number
}
export function readToolLog(p: string): ToolCall[] {
  if (!fs.existsSync(p)) return []
  try {
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l) } catch { return null }
    }).filter((x): x is ToolCall => x !== null)
  } catch { return [] }
}
export async function readToolLogWithRetry(p: string, maxMs = 1000): Promise<ToolCall[]> {
  const start = Date.now()
  let last: ToolCall[] = []
  while (Date.now() - start < maxMs) {
    last = readToolLog(p)
    if (last.length > 0) return last
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return last
}
