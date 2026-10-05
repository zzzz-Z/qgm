// AIRUNNER-BATCH11-1-HOOKS-CONFIG: 类型与配置加载已外移至 hooks-config.ts；此文件保留 runHook 执行编排
import path from 'node:path'
import { getRoot } from '../config.js'
import { runProcess } from '../process/proc.js'
import type { HookEvent, HookResult } from './hooks-config.js'
import { loadHooksConfig } from './hooks-config.js'

/**
 * hooks 配置文件路径；[lazy-path-v1] 改为函数式：原 const 在模块导入时快照 ROOT，
 * standalone 下 setRoot 切换工作区后仍指向启动 cwd（隐藏 bug）
 */
function configPath(): string {
  return path.join(getRoot(), '.ai-runner/hooks.json')
}
/** 单个钩子执行的超时上限（毫秒） */
const HOOK_TIMEOUT_MS = 5000
/**
 * 按事件覆盖超时：[selfcheck-hook-timeout-v1]
 * BeforeDone 的 hook 壳会同步跑 L1 回归（目标 vue-tsc --noEmit 实测约 15s，
 * 多 target 时更久），5s 全局超时必然强杀 → exit -1 被 onFail:reject 判拒 →
 * 正常 DONE 连拒两次熔断（实测 2026-10-05：探针 A/B 全部超时）。
 * 其余事件仍是轻量用户脚本，维持 5s。
 */
// [selfcheck-l2-v1] BeforeDoneFinal 跑 L2 全量（全量 vitest + 4×tsc + 全仓 eslint），
// 实测可能 3～10 分钟，初值 960s；由响应体 durationMs 校准。
// [selfcheck-l2-budget-v2] 复核修正：960s 与 fullgate 内部总预算 T_TOTAL 相等 = **骑在边界上**，
// 只要端点序列化/回传稍慢即会被 hook 先强杀 → exit -1 → onFail:reject → 正常 DONE 连拒两次熔断
// （与期一 `5s < 12s` 同族）。现 hook 抬到 1200s，内部 T_TOTAL 保持 960s，留 4 分钟余量。
const HOOK_TIMEOUT_BY_EVENT: Partial<Record<HookEvent, number>> = { BeforeDone: 180_000, BeforeDoneFinal: 1_200_000 }

// 配置加载已外移至 hooks-config.ts；此处只传路径

/**
 * 读取 Config
 */
function readConfig(): ReturnType<typeof loadHooksConfig> { return loadHooksConfig(configPath()) }

/**
 * 按 hooks 配置依次执行指定事件下的外部命令
 * [WHY] hook 是用户自定义脚本入口（shell 命令），在循环各阶段（BeforeFill/AfterScript 等）插桩
 * [CONSTRAINT] 事件未配置 hook 时直接返回 ok（不报错）；payload 会 JSON 序列化后经 stdin 传入子进程
 * [CHANGE-IMPACT] 返回 action='reject' 会让调用方走失败分支（如 startLoop 提前 finish）
 * @param event 生命周期事件名（须命中 hooks-config 的键）
 * @param payload 事件体；任意可 JSON 序列化的值
 */
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
      // [root-track-v1] cwd 用 getRoot() 动态读取：原 ROOT 是模块级快照，
      // setRoot 切换工作区后 hook 仍在旧目录执行（隐藏 bug，与 git.ts 同类）
      cwd: getRoot(),
      shell: true,
      timeoutMs: HOOK_TIMEOUT_BY_EVENT[event] ?? HOOK_TIMEOUT_MS,
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

// ── [分区] 顶层 re-export 集中区 ──
export type { HookDef, HookEvent, HookResult } from './hooks-config.js'
