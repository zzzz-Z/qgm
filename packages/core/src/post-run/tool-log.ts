// 沙盒内 fs 工具调用日志读取
import fs from 'node:fs'

/** 单条工具调用记录：操作类型、目标路径、大小 */
export interface ToolCall {
  op: string
  path: string
  size: number
}

/**
 * 读取 Tool Log
 * @param p - p
 */
export function readToolLog(p: string): ToolCall[] {
  if (!fs.existsSync(p)) return []
  try {
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l) } catch { return null }
    }).filter((x): x is ToolCall => x !== null)
  } catch { return [] }
}
/**
 * 读取 Tool Log With Retry
 * @param p - p
 * @param maxMs - max Ms
 */
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
