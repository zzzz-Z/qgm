// [run-bash-v1] 从 useAutoLoop.ts 抽出（PLAN 4.7 阈值整改）
import { readNdjson } from '../../../utils/stream'

interface BashExecResult {
  code: number
  stdout: string
  stderr: string
  blacklistHit?: string
  dirty?: boolean
  dirtyFiles: string[]
}

/**
 * 运行 Bash
 * @param cmd - cmd
 */
export async function runBash(cmd: string): Promise<BashExecResult> {
  const out: BashExecResult = { code: -1, stdout: '', stderr: '', dirtyFiles: [] }
  // 自动模式 git 写操作强制拒绝（防 git reset --hard 变形绕过 bash 黑名单）：
  // 服务端 bash-guard 黑名单按子串匹配，AI 可用 `git reset --hard origin/main`、
  // `git push --force-with-lease`、`git checkout -- .`、`git clean -fd` 等变形绕过。
  // 这里在客户端再拦一次：循环自动模式下任何 git 写操作一律拒绝，
  // AI 若需 git 操作必须改用 cjs 或请求人工审批（on-request 流程）。
  const GIT_WRITE_RE = /\bgit\s+(?:push|reset|checkout|clean|stash|rm|branch|merge|rebase|cherry-pick|revert|commit|add|mv|update-ref|reflog|filter-branch|gc|prune)\b/
  if (GIT_WRITE_RE.test(cmd)) {
    out.blacklistHit = 'git write (auto-loop guard)'
    out.stderr = '自动循环模式下禁止 git 写操作（防止变形绕过黑名单）。请改用 cjs 或请求人工审批。'
    return out
  }
  try {
    const res = await fetch('/__ai/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd, bashPolicy: (() => {
        try {
          const p = localStorage.getItem('__ai_bash_policy') || 'on-request'
          return p === 'on-request' ? 'never' : p
        } catch { return 'never' }
      })() }),
    })
    if (!res.ok) {
      let detail: any = {}
      try { detail = await res.json() } catch { }
      if (detail.blacklistHit) out.blacklistHit = detail.blacklistHit
      if (detail.dirty) { out.dirty = true; out.dirtyFiles = detail.files || [] }
      out.stderr = detail.error || `HTTP ${res.status}`
      return out
    }
    if (!res.body) return out
    await readNdjson<{ stream?: string, data?: string, code?: number }>(res.body, (frame) => {
      if (frame.stream === 'stdout') out.stdout += String(frame.data || '')
      else if (frame.stream === 'stderr') out.stderr += String(frame.data || '')
      else if (frame.stream === 'exit') out.code = Number(frame.code ?? -1)
    })
    return out
  } catch (e) {
    out.stderr = `请求异常：${String(e)}`
    return out
  }
}
