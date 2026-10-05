// [repl-proc-v1] 持久 REPL 子进程：stdin 保持打开，按帧写入 NDJSON。
// [WHY] runProcess 的 stdin 一次性 end，无法与常驻进程做多轮请求/响应。
// [CONSTRAINT] 帧协议：每行一个 JSON + 换行；stdout 按换行分帧。
import { spawn } from 'node:child_process'
import type { RunProcessOptions } from './proc.js'

/** 帧：可 JSON 序列化的对象 */
export type ReplFrame = Record<string, unknown>

/** REPL 句柄 */
export interface ReplHandle {
  readonly pid: number | undefined
  readonly alive: boolean
  send: (frame: ReplFrame) => void
  nextFrame: (timeoutMs?: number) => Promise<ReplFrame>
  onExit: (cb: (code: number | null, signal: NodeJS.Signals | null) => void) => void
  close: (timeoutMs?: number) => Promise<void>
  kill: (signal?: NodeJS.Signals) => void
}

export interface ReplProcessOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  maxOutputBytes?: number
}

interface Waiter {
  resolve: (f: ReplFrame) => void
  reject: (e: Error) => void
  timer?: ReturnType<typeof setTimeout>
}
/**
 * 启动持久 REPL 子进程。
 * [CONSTRAINT] 调用方负责 close() / kill()，否则进程泄漏。
 */
export function runReplProcess(cmd: string, options: RunProcessOptions = {}): ReplHandle {
  const child = spawn(cmd, options.args ?? [], { cwd: options.cwd, env: options.env, shell: options.shell })
  const maxOut = options.maxOutputBytes ?? 5_000_000
  let alive = true
  let exited = false
  let outBytes = 0
  let stdoutTail = ''
  const frames: ReplFrame[] = []
  const waiters: Waiter[] = []
  const exitCbs: Array<(c: number | null, s: NodeJS.Signals | null) => void> = []
  let exitCode: number | null = null
  let exitSignal: NodeJS.Signals | null = null
  const fanExit = () => {
    if (exited) return
    exited = true
    alive = false
    for (const w of waiters.splice(0)) {
      if (w.timer) clearTimeout(w.timer)
      w.reject(new Error('REPL_EXITED'))
    }
    for (const cb of exitCbs.splice(0)) {
      try { cb(exitCode, exitSignal) } catch { /* 消费方异常不阻断其它订阅 */ }
    }
  }

  const deliver = (frame: ReplFrame) => {
    const w = waiters.shift()
    if (w) {
      if (w.timer) clearTimeout(w.timer)
      w.resolve(frame)
    } else { frames.push(frame)
    }
  }
  const onStdout = (chunk: Buffer) => {
    outBytes += chunk.length
    if (outBytes > maxOut) { try { child.kill('SIGKILL') } catch { /* 已退出 */ } ; return }
    stdoutTail += chunk.toString()
    let idx = stdoutTail.indexOf(String.fromCharCode(10))
    while (idx >= 0) {
      const line = stdoutTail.slice(0, idx)
      stdoutTail = stdoutTail.slice(idx + 1)
      if (line.trim()) {
        try { deliver(JSON.parse(line) as ReplFrame) } catch { /* 坏帧丢弃 */ }
      }
      idx = stdoutTail.indexOf(String.fromCharCode(10))
    }
  }

  const onStderr = (chunk: Buffer) => {
    outBytes += chunk.length
    if (outBytes > maxOut) { try { child.kill('SIGKILL') } catch { /* 已退出 */ } }
  }
  child.stdout?.on('data', onStdout)
  child.stderr?.on('data', onStderr)
  child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => { exitCode = code; exitSignal = signal; fanExit() })
  child.on('error', () => { fanExit() })

  return {
    get pid() { return child.pid },
    get alive() { return alive },
    send(frame) {
      if (!alive) throw new Error('REPL_EXITED')
      const stdin = child.stdin
      if (!stdin) throw new Error('REPL_NO_STDIN')
      stdin.write(JSON.stringify(frame) + String.fromCharCode(10))
    },
    nextFrame(timeoutMs) {
      const queued = frames.shift()
      if (queued) return Promise.resolve(queued)
      if (!alive) return Promise.reject(new Error('REPL_EXITED'))
      return new Promise<ReplFrame>((resolve, reject) => {
        const w: Waiter = { resolve, reject }
        if (timeoutMs && timeoutMs > 0) {
          w.timer = setTimeout(() => {
            const i = waiters.indexOf(w)
            if (i >= 0) waiters.splice(i, 1)
            reject(new Error('REPL_FRAME_TIMEOUT'))
          }, timeoutMs)
        }
        waiters.push(w)
      })
    },
    onExit(cb) {
      if (exited) { try { cb(exitCode, exitSignal) } catch { /* ignore */ } ; return }
      exitCbs.push(cb)
    },
    async close(timeoutMs = 3000) {
      if (!alive) return
      try { child.stdin?.end() } catch { /* ignore */ }
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } ; resolve() }, timeoutMs)
        child.once('exit', () => { clearTimeout(t); resolve() })
      })
    },
    kill(signal = 'SIGTERM') { try { child.kill(signal) } catch { /* 已退出 */ } },
  }
}
