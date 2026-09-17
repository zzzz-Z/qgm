import { spawn } from 'node:child_process'
import fs from 'node:fs'

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
}

export interface ProcessResult {
  code: number
  stdout: string
  stderr: string
  /** 是否因超时/取消而被杀掉 */
  killed: boolean
}

/**
 * 统一子进程执行：收集输出、超时 SIGTERM→宽限期→SIGKILL 升级、AbortSignal 联动。
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
    let timer: ReturnType<typeof setTimeout> | undefined
    let escalate: ReturnType<typeof setTimeout> | undefined

    const kill = (sig: NodeJS.Signals) => { try { child.kill(sig) } catch { /* 已退出 */ } }

    if (options.timeoutMs) {
      timer = setTimeout(() => {
        killed = true
        timedOut = true
        kill('SIGTERM')
        if (options.killGraceMs !== 0) {
          escalate = setTimeout(() => kill('SIGKILL'), options.killGraceMs ?? 5000)
        }
      }, options.timeoutMs)
    }
    const onAbort = () => { killed = true; clearTimeout(escalate); kill('SIGKILL') }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (d: Buffer) => {
      const s = d.toString(); stdout += s; options.onChunk?.('stdout', s)
    })
    child.stderr?.on('data', (d: Buffer) => {
      const s = d.toString(); stderr += s; options.onChunk?.('stderr', s)
    })
    child.on('error', (e) => {
      clearTimeout(timer); clearTimeout(escalate)
      options.signal?.removeEventListener('abort', onAbort)
      resolve({ code: -1, stdout, stderr: stderr ? `${stderr}\n${String(e)}` : String(e), killed })
    })
    child.on('close', (code) => {
      clearTimeout(timer); clearTimeout(escalate)
      options.signal?.removeEventListener('abort', onAbort)
      const finalStderr = timedOut && options.timeoutMs
        ? `${stderr}\n[${options.timeoutLabel || '超时'} ${Math.round(options.timeoutMs / 1000)}s 强制终止]`
        : stderr
      resolve({ code: code ?? -1, stdout, stderr: finalStderr, killed })
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
