// 子进程脚本执行（overlay 沙盒）
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import { getRoot } from '../config.js'
import { injectAiJsdoc, scanNativeApisWithFallback, scanScriptHead } from './ai-guard.js' // [ai-guard-v1]
import { runProcess } from '../process/proc.js'
import { buildWrapperCode } from './run-script-wrapper.js'

/** 脚本运行的返回结果：退出码、stdout、stderr */
export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * 在受限沙箱中执行 cjs 脚本并收集结果
 * [WHY] 执行前做脚本头契约校验（SCRIPT_META_MISSING）与原生 API 扫描，防止绕过 SYSTEM.md 约束
 * [CONSTRAINT] 失败统一走 code=2 + JSON stderr；onChunk 用于 NDJSON 流式回传（缺省则只返回汇总结果）
 * [CHANGE-IMPACT] 被 run.ts 的 EXECUTE 阶段消费；返回结构的 code / stdout / stderr 决定 pipeline 状态
 * @param scriptPath 脚本文件绝对路径
 * @param timeoutMs 执行超时毫秒数（默认 60s）
 * @param signal 外部取消信号（来自 run.ts 的 AbortController）
 * @param overlayPath 沙箱写操作的 overlay 落盘路径
 * @param toolLogPath 工具调用 JSONL 日志路径
 * @param onChunk stdout / stderr 流式回调；缺省则不流式回传
 * @param sandbox 沙箱级别（read-only / workspace-write / full）
 */
export async function runScript(scriptPath: string, timeoutMs = 60_000, signal?: AbortSignal, overlayPath?: string, toolLogPath?: string, onChunk?: (stream: 'stdout' | 'stderr', data: string) => void, sandbox?: string): Promise<RunResult> {
  try {
    const raw = fs.readFileSync(scriptPath, 'utf8')
    // [script-head-contract-v1] 脚本头契约（先于 API 扫描与注入）
    const head = scanScriptHead(raw)
    if (!head.ok) {
      return {
        code: 2,
        stdout: '',
        stderr: JSON.stringify({
          error: 'SCRIPT_META_MISSING',
          detail: head.reason,
          rule: 'SYSTEM.md',
        }),
      }
    }
    const scan = scanNativeApisWithFallback(raw)
    if (scan.hit) {
      return {
        code: 2,
        stdout: '',
        stderr: JSON.stringify({
          error: 'NATIVE_API_FORBIDDEN',
          detail: scan.matches.join(', '),
          rule: 'SYSTEM.md',
        }),
      }
    }
    const next = injectAiJsdoc(raw)
    if (next !== raw) {
      // [no-backup-v1] 取消 pre-inject 备份：注入内容为固定 JSDoc，幂等且无副作用；
      // 备份会在每轮累积 .pre-inject.<ts> 文件撑爆 .ai-runner/backup（用户要求执行结束即视为无用）
      fs.writeFileSync(scriptPath, next)
    }
  } catch (e) {
    return { code: 2, stdout: '', stderr: JSON.stringify({ error: 'AI_GUARD_IO', detail: String(e) }) }
  }

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
