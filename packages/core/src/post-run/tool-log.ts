// 沙盒内 fs 工具调用日志读取
import fs from 'node:fs'

/** 单条工具调用记录：操作类型、目标路径、大小 */
export interface ToolCall {
  op: string
  path: string
  size: number
}

/**
 * 读取 JSONL 工具日志（每行一个 ToolCall）
 * [WHY] 工具日志由沙箱运行时逐行 append，格式与 NDJSON 一致
 * [CONSTRAINT] 文件不存在或读取失败一律返回空数组；单行 JSON 解析失败的行会被静默丢弃
 * [CHANGE-IMPACT] 被 readToolLogWithRetry 消费；返回结构被 run.ts 用于 tools 字段
 * @param p 日志文件绝对路径
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
 * 轮询读取工具日志直到有内容或超时
 * [WHY] 脚本进程退出与日志刷盘之间存在竞态；直接读可能拿到空日志
 * [CONSTRAINT] 50ms 轮询间隔；超时后返回最后一次结果（可能为空数组）
 * [CHANGE-IMPACT] 超时过小会在慢盘上误报"无工具调用"
 * @param p 日志文件绝对路径
 * @param maxMs 最长等待毫秒数（默认 1000）
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
