// tsc 定向类型检查
import fs from 'node:fs'
import path from 'node:path'
import { runProcess } from '../process/proc.js'
// AIRUNNER-BATCH10-3B-SPLIT-TARGETS: 类型与 root 派生已内联/外移，解除对 config.js 的依赖（strip-types 可加载）

/**
 * 读取项目根目录（AI_RUNNER_ROOT → AIR_ROOT → cwd 逐级回落）
 * [WHY] 内联而非 import config.ts：--experimental-strip-types 不重写 .js → .ts 路径，import 会失败
 * [CONSTRAINT] 每次读 env 而非缓存常量，兼容 config.setRoot 的运行时改动
 */
function getRoot(): string {
  return process.env.AI_RUNNER_ROOT || process.env.AIR_ROOT || process.cwd()
}

/**
 * 封装 runProcess：以项目根为 cwd，收拢 code/stdout/stderr
 * [CONSTRAINT] 不抛错 —— 进程失败由返回的 code 表达，调用方需自行判 0
 * @param cmd 可执行文件绝对路径（vue-tsc / tsc）
 * @param args 命令行参数数组；由 runProcess 负责转义
 * @param timeoutMs 超时毫秒数（默认 60s；批量运行 tsc 时调用方传 120s）
 */
async function runCmd(cmd: string, args: string[], timeoutMs = 60_000): Promise<{ code: number, stdout: string, stderr: string }> {
  const r = await runProcess(cmd, { args, cwd: getRoot(), timeoutMs })
  return { code: r.code, stdout: r.stdout, stderr: r.stderr }
}

/**
 * 对指定文件做定向类型检查
 * [WHY] 全量 tsc 在大型仓库上很慢；按变更目标生成临时 tsconfig，只检必要文件
 * [CONSTRAINT] client 与 server 分组走不同 tsconfig（bundler vs NodeNext）；
 * 无目标 / 无可用 bin 时返回 null（不阻断 run.ts 主流程）
 * [CHANGE-IMPACT] 定向失败且无 error TS 命中时会回退全量；此路径的 stdout 会被 run.ts 消费
 * @param targets 待检文件相对路径列表（pickTscTargets 结果）
 * @param runId 本轮运行 id，用于生成临时 tsconfig 文件名（避免并发冲突）
 */
export async function runTsc(
  targets: string[],
  runId: string,
): Promise<{ ok: boolean, stdout: string, stderr: string } | null> {
  if (!targets.length) return null
  const isWin = process.platform === 'win32'
  const vueTscBin = path.join(getRoot(), 'node_modules', '.bin', isWin ? 'vue-tsc.cmd' : 'vue-tsc')
  const tscBin = path.join(getRoot(), 'node_modules', '.bin', isWin ? 'tsc.cmd' : 'tsc')
  const hasVueTsc = fs.existsSync(vueTscBin)
  const bin = hasVueTsc ? vueTscBin : (fs.existsSync(tscBin) ? tscBin : null)
  if (!bin) return null
  // [p0-tsconfig-split] 分组执行：client 用 bundler，其余用 NodeNext
  const vueTscNote = hasVueTsc ? '' : '[ai-runner] 未找到 vue-tsc，回退 tsc；.vue 文件的类型错误不会被检出\n'

  // [tsc-split-client-v2] client 已迁移到 packages/client/，兼容旧 client/ 前缀
  const isClientPath = (p: string): boolean => p.startsWith('packages/client/') || p.startsWith('client/')
  const serverTargets: string[] = []
  const clientTargets: string[] = []
  for (const t of targets) {
    if (isClientPath(t)) clientTargets.push(t)
    else serverTargets.push(t)
  }

  interface RunResult { code: number, stdout: string, stderr: string }
  const runOne = async (base: string, list: string[], client: boolean): Promise<RunResult> => {
    const bp = path.join(getRoot(), base)
    if (!fs.existsSync(bp)) return { code: 1, stdout: '', stderr: `[ai-runner] 缺少 ${base}\n` }
    const safe = base.replace(/[^a-z0-9]/gi, '_')
    const tmp = path.join(getRoot(), `.ai-runner-tsconfig.${runId}.${safe}.json`)
    const co = client
      ? { skipLibCheck: true, noEmit: true }
      : { lib: ['ES2022', 'DOM', 'DOM.Iterable'], skipLibCheck: true, noEmit: true, rootDir: '.', allowImportingTsExtensions: true }
    const cfg = {
      extends: `./${base}`,
      compilerOptions: co,
      files: [],
      include: [
        ...list.map(p => `./${p}`),
        // [tsc-global-dts-fix] TS extends 语义下 include 是全量覆盖而非合并：精确 include 变更文件
        // 会挤掉 base 的 .d.ts glob，env.d.ts / *.d.ts 等全局声明不参与模块依赖图，脱管后
        // 变更文件引用 import.meta.env / *.vue 会报 TS2339 / TS2307 假阳性
        client ? './packages/client/**/*.d.ts' : './packages/core/src/**/*.d.ts',
      ],
      exclude: ['node_modules', 'dist', '.ai-runner', '.vite'],
    }
    try {
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2))
      return await runCmd(bin, ['-p', tmp, '--noEmit'], 120_000)
    } finally {
      try { fs.unlinkSync(tmp) } catch { /* swallow: 文件可能已被清理 / 权限异常，不掩盖主流程结果 */ }
    }
  }

  const results: RunResult[] = []
  if (serverTargets.length) results.push(await runOne('tsconfig.json', serverTargets, false))
  if (clientTargets.length) results.push(await runOne('tsconfig.client.json', clientTargets, true))
  if (!results.length) {
    const legacy = ['tsconfig.json', 'tsconfig.app.json']
      .map(f => path.join(getRoot(), f))
      .find(f => fs.existsSync(f))
    if (!legacy) return null
    results.push(await runOne(path.basename(legacy), targets, false))
  }

  const code = results.every(r => r.code === 0) ? 0 : 1
  const out = results.map(r => r.stdout).join('')
  const errs = results.map(r => r.stderr).join('')
  const errCount = (`${out}\n${errs}`.match(/\berror TS\d+/g) || []).length
  if (code !== 0 && errCount === 0) {
    const full = await runCmd(bin, ['--noEmit'], 120_000)
    const head = `[ai-runner] 定向配置失败，已回退全量检查\n${vueTscNote}`
    return { ok: full.code === 0, stdout: head + full.stdout, stderr: full.stderr }
  }
  const head = `[ai-runner] 仅检查本次变更的 ${targets.length} 个文件（server=${serverTargets.length} client=${clientTargets.length}）\n${vueTscNote}`
  return { ok: code === 0, stdout: head + out, stderr: errs }
}

// ── [§5 分区] 顶层 re-export 集中区 ──
export { pickTscTargets, TSC_EXTS, TSC_SKIP_DIRS } from './tsc-targets.js'
