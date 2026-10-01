// node:test 执行
import { getRoot } from '../config.js'
import { runProcess } from '../process/proc.js'
import { buildTestArgs } from './test-targets.js'

/**
 * 以项目根为 cwd 执行命令并收敛为 {code, stdout, stderr}
 * [CONSTRAINT] 不抛错 —— 失败由返回的 code 表达；调用方需自行判 0
 * @param cmd 可执行名（如 'node'）
 * @param args 参数数组
 * @param timeoutMs 超时毫秒（默认 60s）
 */
async function runCmd(cmd: string, args: string[], timeoutMs = 60_000): Promise<{ code: number, stdout: string, stderr: string }> {
  const proc = await runProcess(cmd, { args, cwd: getRoot(), timeoutMs })
  return { code: proc.code, stdout: proc.stdout, stderr: proc.stderr }
}
/**
 * 对指定测试文件运行单测
 * [WHY] 只跑本次变更涉及的测试文件，避免全量 vitest 拖慢反馈
 * [CONSTRAINT] 无有效测试目标时返回 {ran:false, ok:true}（视为通过，不阻断流程）；超时固定 30s
 * [CHANGE-IMPACT] ran=false 与 ok=true 的组合会误导 UI 显示"通过"，需靠 ran 字段区分
 * @param testFiles 测试文件相对路径列表
 */
export async function runTests(testFiles: string[]): Promise<{ ran: boolean, ok: boolean, stdout: string, stderr: string }> {
  const { ran, args } = buildTestArgs(testFiles)
  if (!ran) return { ran: false, ok: true, stdout: '', stderr: '' }
  const r = await runCmd('node', args, 30_000)
  return { ran: true, ok: r.code === 0, stdout: r.stdout, stderr: r.stderr }
}
