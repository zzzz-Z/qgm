// [selfcheck-l1-v1] L1 回归核验：触碰 packages/* 时跑目标 tsc + baseline 对比
// [WHY] L0 只证「改动真实」，L1 证「改动没破坏既有类型/测试」；只拦新增错误
// [CONSTRAINT] 与 baseline.json 对比，存量错误放行（避免历史债卡死收尾）
import { runProcess } from '../process/proc.js'
import fs from 'node:fs'
import path from 'node:path'
import { getRoot } from '../config.js'
import type { CheckItem } from './executor.js'

/** 从改动文件列表推断需跑的 tsconfig 目标 */
export function pickTsTargets(changed: string[]): string[] {
  const targets = new Set<string>()
  for (const f of changed) {
    if (f.startsWith('packages/core/')) targets.add('tsconfig.json')
    else if (f.startsWith('packages/client/')) targets.add('tsconfig.client.json')
    else if (f.startsWith('apps/')) targets.add('tsconfig.apps.json')
    else if (f.includes('/tests/')) targets.add('tsconfig.test.json')
  }
  return [...targets]
}

/** baseline 结构（仅取错误计数） */
export interface Baseline { tsc?: { errors?: number }, lint?: { errors?: number } }

/**
 * 跑单个 tsconfig 的 --noEmit，返回错误计数
 * [CONSTRAINT] 命令失败即视为 error 计数无法获取，返回 -1 供调用方 skip
 */
export async function countTscErrors(tsconfig: string, timeoutMs = 60_000): Promise<number> {
  const bin = 'node_modules/.bin/tsc'
  const isVue = tsconfig.includes('client') || tsconfig.includes('test')
  const r = await runProcess(isVue ? 'node_modules/.bin/vue-tsc' : bin, {
    args: ['-p', tsconfig, '--noEmit'],
    cwd: getRoot(),
    timeoutMs,
    timeoutLabel: `L1 tsc ${tsconfig}`,
    shell: process.platform === 'win32',
  })
  const out = String(r.stdout || '') + String(r.stderr || '')
  const m = out.match(/(\d+) error/gi)
  if (!m) return r.code === 0 ? 0 : -1
  let total = 0
  for (const seg of m) total += Number(seg.replace(/\D/g, '')) || 0
  return total
}

/**
 * 快档 lint：只对改动文件跑 eslint（[A-REQ-4] 缺口①，工单 §3「快档 lint」）
 * [CONSTRAINT] 返回 error（severity=2）计数；JSON 解析失败/致命错误返回 -1 供调用方 skip
 */
export async function countLintErrors(files: string[]): Promise<number> {
  // [selfcheck-l1-lint-missing-v1] 必须过滤**不存在的路径**：git 变更集含已删除文件
  //   （实测：`D packages/client/components/panels/PipelineGraph.vue` ⇒ 147 项变更里混着删除项），
  //   eslint 遇到不存在路径直接致命退出（code 2）→ 本项被记 skipped、L1 lint 形同不存在。
  //   同时去重（git diff 与 ls-files 可能重叠）。
  const lintable = [...new Set(files.filter(f => /\.(?:ts|tsx|vue|js|mjs|cjs)$/.test(f)))]
    .filter((f) => { try { return fs.existsSync(path.join(getRoot(), f)) } catch { return false } })
  if (!lintable.length) return 0
  const r = await runProcess('node_modules/.bin/eslint', {
    args: ['--format', 'json', ...lintable],
    cwd: getRoot(),
    timeoutMs: 60_000,
    timeoutLabel: 'L1 eslint',
    shell: process.platform === 'win32',
  })
  // eslint 退出码 1 = 有 lint error（输出仍有效），2 = 致命错误/配置问题
  if (r.code === 2) return -1
  try {
    const arr = JSON.parse(String(r.stdout || '[]')) as Array<{ messages: Array<{ severity: number }> }>
    let total = 0
    for (const f of arr) { for (const m of f.messages) { if (m.severity === 2) total++
    }
    }
    return total
  } catch {
    return -1
  }
}

/** L1 依赖注入点：测试用假计数器替代真实 tsc/eslint 进程（[A-REQ-4] 缺口② 承重前提） */
export interface RegressionDeps {
  tscErrors?: (tsconfig: string) => Promise<number>
  lintErrors?: (files: string[]) => Promise<number>
}

/**
 * L1 主入口：对改动面涉及的 tsconfig 逐个跑并对比 baseline
 * [CONSTRAINT] 无 baseline 或无命中 target → 记 skipped（ok=true）
 * @param changed 实测改动文件
 * @param baseline 基线（.ai-runner/baseline.json 解析对象）
 */
/**
 * 读 .ai-runner/baseline.json；缺失或解析失败返回 null
 * [CONSTRAINT] 解析失败一律 null（等价于跳过对账），不抛错
 */
export function loadBaseline(): Baseline | null {
  try {
    const fp = path.join(getRoot(), '.ai-runner', 'baseline.json')
    if (!fs.existsSync(fp)) return null
    return JSON.parse(fs.readFileSync(fp, 'utf8')) as Baseline
  } catch { return null }
}

export async function runRegression(changed: string[], baseline: Baseline | null, deps: RegressionDeps = {}): Promise<CheckItem[]> {
  const tscOf = deps.tscErrors ?? countTscErrors
  const lintOf = deps.lintErrors ?? countLintErrors
  const targets = pickTsTargets(changed)
  if (!targets.length) {
    return [{ id: 'L1-regression', level: 'L1', ok: true, actual: '无 packages/apps 改动', expected: '无需回归', details: ['[skipped] 本次改动不触及 packages/* 或 apps/*'] }]
  }
  if (!baseline) {
    return [{ id: 'L1-regression', level: 'L1', ok: true, actual: '缺 baseline.json', expected: '跳过对账', details: ['[skipped] 无 baseline 无法判定新增错误'] }]
  }
  const items: CheckItem[] = []
  for (const t of targets) {
    const errors = await tscOf(t)
    if (errors < 0) {
      items.push({ id: `L1-tsc-${t}`, level: 'L1', ok: true, actual: '命令失败', expected: '跳过对账', details: [`[skipped] ${t} 执行失败无法取错误数`] })
      continue
    }
    const baseErrors = Number(baseline.tsc?.errors ?? 0)
    const ok = errors <= baseErrors
    items.push({
      id: `L1-tsc-${t}`,
      level: 'L1',
      ok,
      actual: `${errors} errors`,
      expected: `<= baseline ${baseErrors} errors`,
      details: ok ? undefined : [`${t} 新增 ${errors - baseErrors} 个类型错误`],
    })
  }
  // 快档 lint：只对改动文件对账（lintOf 内部过滤不可 lint 的文件）
  const lintErrors = await lintOf(changed)
  const baseLint = Number(baseline.lint?.errors ?? 0)
  if (lintErrors < 0) {
    items.push({ id: 'L1-lint', level: 'L1', ok: true, actual: '命令失败', expected: '跳过对账', details: ['[skipped] eslint 执行失败无法取错误数'] })
  } else {
    items.push({
      id: 'L1-lint',
      level: 'L1',
      ok: lintErrors <= baseLint,
      actual: `${lintErrors} errors`,
      expected: `<= baseline ${baseLint} errors`,
      details: lintErrors <= baseLint ? undefined : [`新增 ${lintErrors - baseLint} 个 lint error`],
    })
  }
  return items
}
