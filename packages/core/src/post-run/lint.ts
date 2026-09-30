// AIRUNNER-BATCH10-4-SPLIT-LINT
// eslint 检测与执行
import fs from 'node:fs'
import path from 'node:path'
import { getRoot } from '../config.js'
import { detectPackageManager, runProcess } from '../process/proc.js'
/** 支持 eslint 处理的源文件扩展名 */
// AIRUNNER-BATCH10-4-SPLIT-LINT: LINT_EXTS 已移至 lint-targets.ts

/** 从 changes 里挑出需要 lint 的源文件（排除已删除的） */

/** 项目是否有 eslint 配置（无配置不跑，避免 eslint 初始化向导） */

/**
 * 判断是否包含 Eslint
 */
export function hasEslint(): boolean {
  const candidates = [
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.cjs',
    'eslint.config.ts',
    'eslint.config.mts',
    '.eslintrc',
    '.eslintrc.js',
    '.eslintrc.cjs',
    '.eslintrc.json',
    '.eslintrc.yml',
    '.eslintrc.yaml',
  ]
  if (candidates.some(f => fs.existsSync(path.join(getRoot(), f)))) return true
  try {
    const pkgPath = path.join(getRoot(), 'package.json')
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      if (pkg.eslintConfig) return true
    }
  } catch { /* ignore */ }
  return false
}

/** 对给定文件跑 eslint --fix，超时 60s；优先项目本地二进制，否则按项目包管理器调用 */
export async function runEslint(files: string[], timeoutMs = 60_000): Promise<{ code: number, stdout: string, stderr: string }> {
  const binName = process.platform === 'win32' ? 'eslint.cmd' : 'eslint'
  const localBin = path.join(getRoot(), 'node_modules', '.bin', binName)
  if (fs.existsSync(localBin)) {
    const r = await runProcess(localBin, {
      args: ['--fix', ...files],
      cwd: getRoot(),
      timeoutMs,
      timeoutLabel: 'eslint 超时',
      shell: process.platform === 'win32',
    })
    return { code: r.code, stdout: r.stdout, stderr: r.stderr }
  }
  const pm = detectPackageManager(getRoot())
  const execArgs = pm === 'yarn'
    ? ['eslint', '--fix', ...files]
    : pm === 'npm'
      ? ['exec', '--no', 'eslint', '--fix', ...files]
      : ['exec', 'eslint', '--fix', ...files]
  const r = await runProcess(pm, {
    args: execArgs,
    cwd: getRoot(),
    timeoutMs,
    timeoutLabel: 'eslint 超时',
    shell: process.platform === 'win32',
  })
  return { code: r.code, stdout: r.stdout, stderr: r.stderr }
}

// ── [§5 分区] 顶层 re-export 集中区 ──
export { LINT_EXTS, pickLintTargets } from './lint-targets.js'
