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
/** 单测执行结果；reason 仅在 ran=false 时有值 */
export interface TestRunResult {
  ran: boolean
  ok: boolean
  stdout: string
  stderr: string
  /**
   * [test-skip-reason-v1] 未运行的原因。
   *   此前只回 `{ ran:false, ok:true }`，消费方无法区分「无测试目标（根本没跑）」
   *   与「跑了且通过」——UI 徽标与回填 prompt 都会把前者当后者展示（原注释已自认会误导）。
   */
  reason?: 'no-test-targets'
}

/**
 * 对指定测试文件运行单测
 * [WHY] 只跑本次变更涉及的测试文件，避免全量 vitest 拖慢反馈
 * [CONSTRAINT] 无有效测试目标时返回 `{ ran:false, ok:true, reason:'no-test-targets' }`；
 *   保留 ok:true —— 无目标不是失败、不应阻断流程，靠 ran + reason 让消费方可区分「没跑」与「通过」；超时固定 30s
 * [CHANGE-IMPACT] 改动返回形状须同步 client 的 RunResponse.test 类型与 appendFeedbackSummary
 * @param testFiles 测试文件相对路径列表
 */
export async function runTests(testFiles: string[]): Promise<TestRunResult> {
  const { ran, args } = buildTestArgs(testFiles)
  if (!ran) return { ran: false, ok: true, stdout: '', stderr: '', reason: 'no-test-targets' }
  const r = await runCmd('node', args, 30_000)
  return { ran: true, ok: r.code === 0, stdout: r.stdout, stderr: r.stderr }
}
