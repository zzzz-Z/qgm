// 子进程脚本执行（overlay 沙盒）
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import { getRoot } from '../config.js'
import { injectAiJsdoc, scanNativeApisWithFallback, scanScriptHead } from './ai-guard.js'; // [ai-guard-v1]
import { runProcess } from '../process/proc.js'
import { buildWrapperCode } from './run-script-wrapper.js'

/** 脚本运行的返回结果：退出码、stdout、stderr */
export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * 运行 Script
 * @param scriptPath - script Path
 * @param timeoutMs - timeout Ms
 * @param signal - signal
 * @param overlayPath - overlay Path
 * @param toolLogPath - tool Log Path
 * @param onChunk - on Chunk
 * @param data - data
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
      const bakDir = path.join(getRoot(), '.ai-runner', 'backup')
      try { fs.mkdirSync(bakDir, { recursive: true }) } catch { /* 备份失败不阻断执行 */ }
      try { fs.writeFileSync(path.join(bakDir, `${path.basename(scriptPath)}.pre-inject.${Date.now()}`), raw) } catch { /* 同上 */ }
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
