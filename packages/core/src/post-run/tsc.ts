// tsc 定向类型检查
import fs from 'node:fs'
import path from 'node:path'
import { runProcess } from '../process/proc.js'
// AIRUNNER-BATCH10-3B-SPLIT-TARGETS: 类型与 root 派生已内联/外移，解除对 config.js 的依赖（strip-types 可加载）

/**
 * 获取 Root
 */
function getRoot(): string {
  return process.env.AI_RUNNER_ROOT || process.env.AIR_ROOT || process.cwd()
}

/**
 * 运行 Cmd
 * @param cmd - cmd
 * @param args - args
 * @param timeoutMs - timeout Ms
 */
async function runCmd(cmd: string, args: string[], timeoutMs = 60_000): Promise<{ code: number, stdout: string, stderr: string }> {
  const r = await runProcess(cmd, { args, cwd: getRoot(), timeoutMs })
  return { code: r.code, stdout: r.stdout, stderr: r.stderr }
}

export { pickTscTargets, TSC_EXTS, TSC_SKIP_DIRS } from './tsc-targets.js'

/**
 * 运行 Tsc
 * @param targets - targets
 * @param runId - run Id
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
      include: list.map(p => `./${p}`),
      exclude: ['node_modules', 'dist', '.ai-runner', '.vite'],
    }
    try {
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2))
      return await runCmd(bin, ['-p', tmp, '--noEmit'], 120_000)
    } finally {
      try { fs.unlinkSync(tmp) } catch { }
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
