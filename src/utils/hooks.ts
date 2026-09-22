// AIRUNNER-BATCH11-1-HOOKS-CONFIG: 类型与配置加载已外移至 hooks-config.ts；此文件保留 runHook 执行编排
import path from 'node:path'
import { ROOT } from '../config.js'
import { runProcess } from '../process/proc.js'
import type { HookEvent, HookResult } from './hooks-config.js'
import { loadHooksConfig } from './hooks-config.js'

export type { HookDef, HookEvent, HookResult } from './hooks-config.js'

const CONFIG_PATH = path.join(ROOT, '.ai-runner/hooks.json')
const HOOK_TIMEOUT_MS = 5000

// 配置加载已外移至 hooks-config.ts；此处只传路径
const readConfig = () => loadHooksConfig(CONFIG_PATH)

export async function runHook(event: HookEvent, payload: unknown): Promise<HookResult> {
  const cfg = readConfig()
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
