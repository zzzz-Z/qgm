// node:test 执行
import { getRoot } from '../config.js'
import { runProcess } from '../process/proc.js'
import { buildTestArgs } from './test-targets.js'

async function runCmd(cmd: string, args: string[], timeoutMs = 60_000): Promise<{ code: number, stdout: string, stderr: string }> {
  const r = await runProcess(cmd, { args, cwd: getRoot(), timeoutMs })
  return { code: r.code, stdout: r.stdout, stderr: r.stderr }
}
export async function runTests(testFiles: string[]): Promise<{ ran: boolean, ok: boolean, stdout: string, stderr: string }> {
  const { ran, args } = buildTestArgs(testFiles)
  if (!ran) return { ran: false, ok: true, stdout: '', stderr: '' }
  const r = await runCmd('node', args, 30_000)
  return { ran: true, ok: r.code === 0, stdout: r.stdout, stderr: r.stderr }
}
