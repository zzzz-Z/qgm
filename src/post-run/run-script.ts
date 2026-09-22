// 子进程脚本执行（overlay 沙盒）
import { fileURLToPath } from 'node:url'
import { getRoot } from '../config.js'
import { runProcess } from '../process/proc.js'
import { buildWrapperCode } from './run-script-wrapper.js'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export async function runScript(scriptPath: string, timeoutMs = 60_000, signal?: AbortSignal, overlayPath?: string, toolLogPath?: string, onChunk?: (stream: 'stdout' | 'stderr', data: string) => void, sandbox?: string): Promise<RunResult> {
  // 全局错误捕获 wrapper（console 走原生输出，拦截器负责文件 API，无需包裹）
  const wrapperCode = buildWrapperCode(scriptPath) // AIRUNNER-BATCH11-4-WRAPPER
  // src/post-run/ 或 dist/post-run/ 都回 ../../
  const interceptorCjs = fileURLToPath(new URL('../interceptor.cjs', import.meta.url))
  const helpersCjs = fileURLToPath(new URL('../helpers.cjs', import.meta.url))
  const r = await runProcess(process.execPath, {
    // [F7] semi-space 调小（64MB），GC 更频繁，防大对象堆积；总堆仍 512MB
    args: ['--max-old-space-size=512', '--max-semi-space-size=64', '-r', interceptorCjs, '-r', helpersCjs, '-e', wrapperCode],
    cwd: getRoot(),
    env: {
      ...process.env,
      AI_RUNNER_OVERLAY: overlayPath || '',
      AI_RUNNER_TOOL_LOG: toolLogPath || '',
      AI_RUNNER_SANDBOX: sandbox || 'read-only',
    },
    timeoutMs,
    signal,
    onChunk,
  })
  return { code: r.code, stdout: r.stdout, stderr: r.stderr }
}
