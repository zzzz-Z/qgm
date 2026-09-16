import { useSessionManager } from './useSessionManager'
import { toast } from './useToast'

export interface ScriptExecutionResult {
  ok: boolean
  code: number
  stdout: string
  stderr: string
  runId: string
}

export function useScriptExecutor() {
  const { sessionId, sessionUrl } = useSessionManager()

  function getContext(): { SESSION_ID: string, SESSION_URL: string, INJECTED_AT: string } {
    return Object.freeze({
      SESSION_ID: sessionId.value,
      SESSION_URL: sessionUrl.value,
      INJECTED_AT: new Date().toISOString(),
    })
  }

  function isCompliant(scriptCode: string): boolean {
    return scriptCode.includes('__SESSION_ID__') && scriptCode.includes('__SESSION_URL__')
  }

  function injectContext(scriptCode: string): string {
    if (isCompliant(scriptCode)) return scriptCode
    const header = [
      `const __SESSION_ID__ = ${JSON.stringify(sessionId.value)}`,
      `const __SESSION_URL__ = ${JSON.stringify(sessionUrl.value)}`,
    ].join('\n')
    return `${header}\n\n${scriptCode}`
  }

  async function executeScript(scriptCode: string): Promise<ScriptExecutionResult> {
    const ctx = getContext()
    if (!isCompliant(scriptCode)) {
      console.warn('[useScriptExecutor] 脚本未声明会话标识，已自动注入', ctx)
    }
    const code = injectContext(scriptCode)
    const res = await fetch('/__ai/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: code, gitCommit: false, smoke: false }),
    })
    let data: { ok?: boolean, code?: number, stdout?: string, stderr?: string, runId?: string, error?: string } = {}
    try { data = await res.json() } catch { }
    if (!res.ok || data.error) {
      toast(`脚本执行失败：${String(data.error || res.status)}`, 'error')
    }
    return {
      ok: Boolean(data.ok),
      code: Number(data.code ?? -1),
      stdout: String(data.stdout || ''),
      stderr: String(data.stderr || ''),
      runId: String(data.runId || ''),
    }
  }

  return { executeScript, isCompliant, injectContext, getContext }
}
