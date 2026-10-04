// [git-runner-v1] git 命令执行器与可用性检查（从 git.ts 抽出）。
// [WHY] git.ts 超 §4 模块 400 行；run / gitAvailable 是 worklog / snapshot 等基础层，独立后可共享。
// [CHANGE-IMPACT] git.ts 通过 import + re-export 保持 API 兼容。

import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './config.js'
import { runProcess } from './process/proc.js'

/** git 可用性缓存；null 表示尚未探测 */
let cachedAvailable: boolean | null = null
// [root-track-v1] 记录上次探测时的 ROOT：setRoot 换工作区后旧缓存失效（隐藏 bug）
let cachedRoot: string | null = null

/**
 * 以项目根为 cwd 执行外部命令（git 专用封装）
 * [CONSTRAINT] 不抛错 —— 进程失败由返回的 code 表达；超时标签固定 'git 超时'
 * [WHY] 统一注入 git 环境变量：GIT_PAGER=cat 落 stdout 不分页；GIT_TERMINAL_PROMPT=0 禁交互
 * [CHANGE-IMPACT] 被 git.ts 与 git-worklog.ts 共同消费；改签名需同步。
 */
export async function run(cmd: string, args: string[], timeoutMs = 30_000, extraEnv?: Record<string, string>): Promise<{ code: number, stdout: string, stderr: string }> {
  const env = {
    ...process.env,
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    ...(extraEnv || {}),
  }
  // [git-full-output-v1] 输出上限 50MB，避免超大 diff 被默认 5MB 截断
  const proc = await runProcess(cmd, { args, cwd: ROOT, env, maxOutputBytes: 50_000_000, timeoutMs, timeoutLabel: 'git 超时' })
  return { code: proc.code, stdout: proc.stdout, stderr: proc.stderr }
}

/** 检查：是否在 git 仓库且 git 命令可用（含 ROOT 变更时的缓存失效） */
export async function gitAvailable(): Promise<boolean> {
  if (cachedRoot !== ROOT) { cachedAvailable = null; cachedRoot = ROOT }
  if (cachedAvailable !== null) return cachedAvailable
  if (!fs.existsSync(path.join(ROOT, '.git'))) { cachedAvailable = false; return false }
  const r = await run('git', ['rev-parse', '--is-inside-work-tree'])
  cachedAvailable = r.code === 0 && r.stdout.trim() === 'true'
  return cachedAvailable
}
