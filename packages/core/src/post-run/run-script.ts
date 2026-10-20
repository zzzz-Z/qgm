// 子进程脚本执行（overlay 沙盒）
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import { getRoot } from '../config.js'
import { getScopeWorkspaceId } from '../workspace-scope.js'
import { injectAiJsdoc, scanNativeApisWithFallback, scanScriptHead } from './ai-guard.js' // [ai-guard-v1]
import { runProcess } from '../process/proc.js'
import { buildWrapperCode } from './run-script-wrapper.js'
import { COLOR_ENV_OVERRIDES } from '../process/bash-guard.js'
import { SCRIPT_TIMEOUT_HINT, SCRIPT_TIMEOUT_MS } from '../process/timeouts.js'

/** 脚本运行的返回结果：退出码、stdout、stderr */
export interface RunResult {
  code: number
  stdout: string
  stderr: string
  // [run-timeout-visible-v1] 透传「是否因超时被杀」。AI 只看 code 时，超时（-1/143）
  //   与真失败无法区分 → 会把「文件已写完的超时」当失败重试；此字段让判据唯一。
  timedOut?: boolean
}

/**
 * 在受限沙箱中执行 cjs 脚本并收集结果
 * [WHY] 执行前做脚本头契约校验（SCRIPT_META_MISSING）与原生 API 扫描，防止绕过 SYSTEM.md 约束
 * [CONSTRAINT] 失败统一走 code=2 + JSON stderr；onChunk 用于 NDJSON 流式回传（缺省则只返回汇总结果）
 * [CHANGE-IMPACT] 被 run.ts 的 EXECUTE 阶段消费；返回结构的 code / stdout / stderr 决定 pipeline 状态
 * @param scriptPath 脚本文件绝对路径
 * @param timeoutMs 执行超时毫秒数（缺省取 SCRIPT_TIMEOUT_MS，同源于 process/timeouts.ts）
 * @param signal 外部取消信号（来自 run.ts 的 AbortController）
 * @param overlayPath 沙箱写操作的 overlay 落盘路径
 * @param toolLogPath 工具调用 JSONL 日志路径
 * @param onChunk stdout / stderr 流式回调；缺省则不流式回传
 * @param sandbox 沙箱级别（read-only / workspace-write / full）
 * @param sessionId 当前会话 id（注入 AI_RUNNER_SESSION_ID 供 __AI__.tasks 分桶用）
 */
export async function runScript(
  scriptPath: string,
  timeoutMs = SCRIPT_TIMEOUT_MS,
  signal?: AbortSignal,
  overlayPath?: string,
  toolLogPath?: string,
  onChunk?: (stream: 'stdout' | 'stderr', data: string) => void,
  sandbox?: string,
  sessionId?: string
): Promise<RunResult> {
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
    // [advisory-v1] 软提示随回执输出：不阻断执行，但让 AI 看到「这里可以改用原生 API」
    if (scan.warnings && scan.warnings.length > 0) {
      for (const w of scan.warnings) console.error(`[advisory] ${w}`)
    }

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
      AI_RUNNER_SESSION_ID: sessionId || '',
      // [multi-workspace-v1] 本次运行所属工作区（ALS 作用域），沙箱内 __AI__ 与日志可按其分桶
      AI_RUNNER_WORKSPACE_ID: getScopeWorkspaceId() || '',
      ...COLOR_ENV_OVERRIDES,
    },
    timeoutMs,
    signal,
    onChunk,
    // [run-timeout-visible-v1] 短标签，与 stderr 里的教学后缀分工：标签给「是什么」，后缀给「怎么办」
    timeoutLabel: 'sandbox-timeout',
  })
  // [sandbox-timeout-hint-v1] 超时轮把绕行指引并进 stderr：AI 只看 code=-1 时会把「超时」
  //   当「失败」无脑重试（白烧轮次），后缀让它一眼看到 background 出口
  const errText = r.timedOut ? `${r.stderr}\n${SCRIPT_TIMEOUT_HINT}` : r.stderr
  return { code: r.code, stdout: r.stdout, stderr: errText, timedOut: r.timedOut }
}
