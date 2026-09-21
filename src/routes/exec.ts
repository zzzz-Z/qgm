// /exec —— shell 流式执行
import type { IncomingMessage, ServerResponse } from 'node:http'
import { getRoot } from '../config.js'
import { BASH_TIMEOUT_MS, buildEnvWhitelist, checkBashBlacklist } from '../process/bash-guard.js'
import { gitPreExecCheck } from '../git.js'
import { runProcess } from '../process/proc.js'
import { parseJSON, readBody, sendJSON } from '../server/http.js'

/** POST /exec { cmd } → NDJSON 流式 shell 执行 */
export async function handleExecRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (req.method !== 'POST' || url.pathname !== '/exec') return false
  const body = parseJSON<{ cmd?: string, allowDirty?: boolean, bashPolicy?: string }>(await readBody(req))
  const cmd = String(body?.cmd || '').trim()
  if (!cmd) {
    sendJSON(res, { error: 'cmd 为空' }, 400)
    return true
  }

  // 1. 黑名单（命中一律拒绝）
  const hit = checkBashBlacklist(cmd)
  if (hit) {
    const policy = String(body?.bashPolicy || 'always')
    if (policy === 'on-request') {
      sendJSON(res, { error: '需要确认', needsApproval: true, blacklistHit: hit, cmd }, 400)
      return true
    }
    sendJSON(res, { error: `命中黑名单（policy=${policy}）：${hit}`, blacklistHit: hit }, 400)
    return true
  }

  // 2. git 跑前检查
  const gitCheck = await gitPreExecCheck()
  if (!gitCheck.ok && gitCheck.dirty && !body?.allowDirty) {
    sendJSON(res, {
      error: '工作区不干净，请先 commit 或 stash',
      dirty: true,
      files: gitCheck.files,
    }, 400)
    return true
  }

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  })
  const write = (obj: unknown) => {
    try { res.write(`${JSON.stringify(obj)}\n`) } catch { /* ignore */ }
  }
  if (gitCheck.ok) {
    write({ stream: 'meta', rollbackRef: gitCheck.rollbackRef })
  }
  const ac = new AbortController()
  req.on('aborted', () => ac.abort())
  const r = await runProcess(cmd, {
    cwd: getRoot(),
    env: buildEnvWhitelist(getRoot()),
    shell: true,
    timeoutMs: BASH_TIMEOUT_MS,
    timeoutLabel: 'bash 超时',
    signal: ac.signal,
    onChunk: (stream, data) => write({ stream, data }),
  })
  write({ stream: 'exit', code: r.code })
  res.end()
  return true
}
