// [refactor-post-run] tsc 定向类型检查
import fs from 'node:fs'
import path from 'node:path'
import { getRoot } from '../config.js'
import type { Change } from '../config.js'
import { runProcess } from '../proc.js'

async function runCmd(cmd: string, args: string[], timeoutMs = 60_000): Promise<{ code: number, stdout: string, stderr: string }> {
  const r = await runProcess(cmd, { args, cwd: getRoot(), timeoutMs })
  return { code: r.code, stdout: r.stdout, stderr: r.stderr }
}
export const TSC_EXTS = new Set(['.ts', '.tsx', '.vue', '.mts', '.cts'])

// pickTscTargets 排除测试文件：e2e/spec/test 归 playwright / node:test 管，不走根 tsconfig
export const TSC_SKIP_DIRS = ['client/e2e/', 'e2e/', 'test/', 'tests/']
const TSC_SKIP_RE = /\.(spec|test)\.(ts|tsx|mts|cts|vue)$/
export function pickTscTargets(changes: Change[]): string[] {
  return changes
    .filter(c => c.type !== 'deleted')
    .map(c => c.path)
    .filter(p => TSC_EXTS.has(path.extname(p).toLowerCase()) || path.extname(p).toLowerCase() === '.vue')
    .filter(p => !TSC_SKIP_DIRS.some(d => p.startsWith(d)))
    .filter(p => !TSC_SKIP_RE.test(p))
}

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
  const baseConfig = ['tsconfig.json', 'tsconfig.app.json']
    .map(f => path.join(getRoot(), f))
    .find(f => fs.existsSync(f))
  if (!baseConfig) return null
  const vueTscNote = hasVueTsc ? '' : '[ai-runner] 未找到 vue-tsc，回退 tsc；.vue 文件的类型错误不会被检出\n'
  const tmpConfig = path.join(getRoot(), `.ai-runner-tsconfig.${runId}.json`)
  const cfg = {
    extends: `./${path.basename(baseConfig)}`,
    compilerOptions: {
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      skipLibCheck: true,
      noEmit: true,
      // [fix] 覆盖 rootDir：允许 client/*.vue 进入检查（原 rootDir=./src 会触发 TS6059）
      rootDir: '.',
      // [fix-allow-ts-ext-v1] 支持 client/*.node-test.ts 的 .ts 后缀导入
      allowImportingTsExtensions: true,
    },
    files: [],
    include: targets.map(p => `./${p}`),
    exclude: ['node_modules', 'dist', '.ai-runner', '.vite'],
  }
  const r = await (async () => {
    try {
      fs.writeFileSync(tmpConfig, JSON.stringify(cfg, null, 2))
      return await runCmd(bin, ['-p', tmpConfig, '--noEmit'], 120_000)
    } finally {
      try { fs.unlinkSync(tmpConfig) } catch { }
    }
  })()
  const errCount = (`${r.stdout}\n${r.stderr}`.match(/\berror TS\d+/g) || []).length
  if (r.code !== 0 && errCount === 0) {
    const full = await runCmd(bin, ['--noEmit'], 120_000)
    const head = `[ai-runner] 定向配置失败，已回退全量检查\n${vueTscNote}`
    return { ok: full.code === 0, stdout: head + full.stdout, stderr: full.stderr }
  }
  const head = `[ai-runner] 仅检查本次变更的 ${targets.length} 个文件\n${vueTscNote}`
  return { ok: r.code === 0, stdout: head + r.stdout, stderr: r.stderr }
}
