import { spawn } from 'node:child_process'
import fs from 'node:fs'

/** 子进程启动配置：命令、参数、超时、工作目录、信号 */
export interface RunProcessOptions {
  args?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  shell?: boolean | string
  /** 触发后先 SIGTERM；缺省不超时 */
  timeoutMs?: number
  /** 外部取消：立即 SIGKILL */
  signal?: AbortSignal
  /** SIGTERM 后多久升级为 SIGKILL，默认 5000ms；0 表示不升级 */
  killGraceMs?: number
  /** 超时附加信息前缀，默认「超时」 */
  timeoutLabel?: string
  onChunk?: (stream: 'stdout' | 'stderr', data: string) => void
  stdin?: string
  // [resource-limit-v1] 输出累积上限（bytes）：超限即 kill
  maxOutputBytes?: number
}

/** 子进程执行结果：退出码、stdout、stderr */
export interface ProcessResult {
  code: number
  stdout: string
  stderr: string
  /** 是否因超时/取消而被杀掉 */
  killed: boolean
  /** [resource-limit-v1] 输出是否因超限被截断 */
  truncated?: boolean
}

/**
 * 统一子进程执行：收集输出、超时 SIGTERM→宽限期→SIGKILL 升级、AbortSignal 联动。
 */

/**
 * 以 Promise 形式执行外部命令（含超时与取消）
 * [WHY] 子进程事件模型不适合直接 await；此封装把 close/error/timeout 统一收敛为 resolve
 * [CONSTRAINT] 不 reject —— 失败通过返回结构的 code / timedOut / killed 表达；
 * stdout / stderr 全量缓冲在内存，超大输出会占用较多内存
 * [CHANGE-IMPACT] 被 git.ts / tsc.ts / run-script.ts 等大量消费；改返回结构会影响所有调用方
 * @param cmd 可执行名或路径
 * @param options 运行参数（args / cwd / env / shell / stdin / timeoutMs / timeoutLabel）
 */
export function runProcess(cmd: string, options: RunProcessOptions = {}): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, options.args ?? [], {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell,
    })
    if (options.stdin !== undefined && child.stdin) {
      child.stdin.end(options.stdin)
    }
    let stdout = ''
    let stderr = ''
    let killed = false
    let timedOut = false
    // [resource-limit-v1]
    let truncated = false
    const maxOut = options.maxOutputBytes ?? 5_000_000
    let outBytes = 0
    const checkOverflow = (): boolean => {
      if (truncated) return true
      if (outBytes > maxOut) {
        truncated = true
        killed = true
        try { child.kill('SIGKILL') } catch { /* 已退出 */ }
        return true
      }
      return false
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    let escalate: ReturnType<typeof setTimeout> | undefined

    const kill = (sig: NodeJS.Signals) => { try { child.kill(sig) } catch { /* 已退出 */ } }

    if (options.timeoutMs) {
      timer = setTimeout(() => {
        killed = true
        timedOut = true
        kill('SIGTERM')
        if (options.killGraceMs !== 0) {
          escalate = setTimeout(kill, options.killGraceMs ?? 5000, 'SIGKILL')
        }
      }, options.timeoutMs)
    }
    const onAbort = () => { killed = true; clearTimeout(escalate); kill('SIGKILL') }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (d: Buffer) => {
      if (truncated) return
      const s = d.toString(); stdout += s; outBytes += d.length; options.onChunk?.('stdout', s)
      checkOverflow()
    })
    child.stderr?.on('data', (d: Buffer) => {
      if (truncated) return
      const s = d.toString(); stderr += s; outBytes += d.length; options.onChunk?.('stderr', s)
      checkOverflow()
    })
    child.on('error', (e) => {
      clearTimeout(timer); clearTimeout(escalate)
      options.signal?.removeEventListener('abort', onAbort)
      resolve({ code: -1, stdout, stderr: stderr ? `${stderr}\n${String(e)}` : String(e), killed, truncated })
    })
    child.on('close', (code) => {
      clearTimeout(timer); clearTimeout(escalate)
      options.signal?.removeEventListener('abort', onAbort)
      const finalStderr = timedOut && options.timeoutMs
        ? `${stderr}\n[${options.timeoutLabel || '超时'} ${Math.round(options.timeoutMs / 1000)}s 强制终止]`
        : stderr
      resolve({ code: code ?? -1, stdout, stderr: finalStderr, killed, truncated })
    })
  })
}

/** 探测项目使用的包管理器（按锁文件） */
export function detectPackageManager(root: string): 'pnpm' | 'yarn' | 'npm' {
  // 优先尊重调用方自身所在的包管理器
  const execPath = process.env.npm_execpath || ''
  if (/pnpm/.test(execPath)) return 'pnpm'
  if (/yarn/.test(execPath)) return 'yarn'
  // 回退：按锁文件判断
  if (fs.existsSync(`${root}/pnpm-lock.yaml`)) return 'pnpm'
  if (fs.existsSync(`${root}/yarn.lock`)) return 'yarn'
  return 'npm'
}
