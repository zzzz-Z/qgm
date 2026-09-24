// [arch-hono/exec-v1] /exec 路由 Hono 版（NDJSON 流式 shell 执行）
import { Hono } from 'hono'
import { getRoot } from '../config.js'
import { BASH_TIMEOUT_MS, buildEnvWhitelist, checkBashBlacklist, checkBashWhitelist } from '../process/bash-guard.js'
import { gitPreExecCheck } from '../git.js'
import { runProcess } from '../process/proc.js'

/** exec 路由的 Hono 实例 */
export const execHono = new Hono()

execHono.post('/exec', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { cmd?: string, allowDirty?: boolean, bashPolicy?: string } | null
  const cmd = String(body?.cmd || '').trim()
  if (!cmd) return c.json({ error: 'cmd 为空' }, 400)

  const wl = checkBashWhitelist(cmd)
  const hit = checkBashBlacklist(cmd)
  if (hit) {
    const policy = String(body?.bashPolicy || 'always')
    if (policy === 'on-request') {
      return c.json({ error: '需要确认', needsApproval: true, blacklistHit: hit, cmd }, 400)
    }
    return c.json({ error: `命中黑名单（policy=${policy}）：${hit}`, blacklistHit: hit }, 400)
  }
  if (wl.verdict === 'unknown' && process.env.AI_RUNNER_WHITELIST_DEBUG) {
    console.warn(`[ai-runner][whitelist] unknown cmd: ${wl.cmd} — ${wl.reason || ''}`)
  }

  const gitCheck = await gitPreExecCheck()
  if (!gitCheck.ok && gitCheck.dirty && !body?.allowDirty) {
    return c.json({
      error: '工作区不干净，请先 commit 或 stash',
      dirty: true,
      files: gitCheck.files,
    }, 400)
  }

  const enc = new TextEncoder()
  const ac = new AbortController()
  // Hono 请求的中止信号（客户端断开）
  try { c.req.raw.signal.addEventListener('abort', () => ac.abort()) } catch { /* ignore */ }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      /** 写入 */
      const write = (obj: unknown) => {
        try { controller.enqueue(enc.encode(`${JSON.stringify(obj)}\n`)) } catch { /* ignore */ }
      }
      if (gitCheck.ok) write({ stream: 'meta', rollbackRef: gitCheck.rollbackRef })
      try {
        const r = await runProcess(cmd, {
          cwd: getRoot(),
          env: buildEnvWhitelist(getRoot()),
          shell: true,
          timeoutMs: BASH_TIMEOUT_MS,
          timeoutLabel: 'bash 超时',
          signal: ac.signal,
          onChunk: (s: string, data: string) => write({ stream: s, data }),
        })
        write({ stream: 'exit', code: r.code })
      } catch (e) {
        write({ stream: 'exit', code: -1, error: String(e) })
      }
      controller.close()
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  })
})
