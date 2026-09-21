import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from '../config.js'
import { runProcess } from '../process/proc.js'

export type HookEvent = 'BeforeFill' | 'BeforeScript' | 'AfterScript' | 'AfterResult' | 'LoopStop'

export interface HookDef {
  command: string
  onFail?: 'reject' | 'warn'
}

export interface HookResult {
  event: HookEvent
  action: 'ok' | 'reject'
  reason?: string
  hooksRun: number
}

const CONFIG_PATH = path.join(ROOT, '.ai-runner/hooks.json')
const HOOK_TIMEOUT_MS = 5000

function loadHooksConfig(): Record<string, HookDef[]> {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return {}
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as Record<string, HookDef[]>
  } catch {
    return {}
  }
}

export async function runHook(event: HookEvent, payload: unknown): Promise<HookResult> {
  const cfg = loadHooksConfig()
  const hooks = Array.isArray(cfg[event]) ? cfg[event] : []
  if (!hooks.length) return { event, action: 'ok', hooksRun: 0 }

  const input = JSON.stringify({ event, payload })
  let run = 0

  for (const h of hooks) {
    const cmd = String((h && h.command) || '').trim()
    if (!cmd) continue
    run++
    const r = await runProcess(cmd, {
      cwd: ROOT,
      shell: true,
      timeoutMs: HOOK_TIMEOUT_MS,
      timeoutLabel: `hook ${event} 超时`,
      stdin: input,
    })
    if (r.code !== 0) {
      const failMode = h.onFail === 'warn' ? 'warn' : 'reject'
      if (failMode === 'reject') {
        return {
          event,
          action: 'reject',
          reason: `hook 失败（exit ${r.code}）: ${(r.stderr || r.stdout || cmd).slice(-300)}`,
          hooksRun: run,
        }
      }
      continue
    }
    try {
      const out = r.stdout.trim()
      if (!out) continue
      const j = JSON.parse(out)
      if (j && j.action === 'reject') {
        return {
          event,
          action: 'reject',
          reason: String(j.reason || 'hook rejected'),
          hooksRun: run,
        }
      }
    } catch {
      // 非 JSON stdout 视为通过
    }
  }

  return { event, action: 'ok', hooksRun: run }
}
