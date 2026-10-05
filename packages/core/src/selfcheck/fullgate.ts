// [selfcheck-l2-v1] L2 全量门：全量 vitest + 4×tsc + 全仓 eslint + B1 产物反查（串行）
// [WHY] 期一 L0+L1 证改动真实 + 不破坏类型基线，但证不了逻辑正确；
//       对标宿主侧复核方交付级验收管线，把质检层补进应用端。
// [CONSTRAINT] 并发跑 vitest 会让守卫测试 timeout 误报 → 串行，不做并行加速。
// [CONSTRAINT] 命令失败 / 解析失败 / 超时记 skipped + degraded，不判 pass（跑不了 ≠ 全绿）。
//
// [selfcheck-l2-v2] A 侧复核修正（2026-10-05，四处实测缺陷）：
//   ① [budget] hook 超时（BeforeDoneFinal）是**外层**约束：段预算之和 + 总 deadline 必须显著小于它，
//      否则 hook 先强杀 → 客户端 exit -1 → onFail:reject → 正常 DONE 连拒两次熔断
//      （与期一 `5s < 12s` 同族坑）。现：单段预算由总预算硬护栏收口，hook 超时另置于 hooks.ts。
//   ② [lint] 判据由「绝对 0」改为**对 baseline 只拦新增**，并排除运行态目录：
//      实测全仓 eslint 存量 13 error 全在 `.workbuddy/memory/*`（宿主侧记忆，非交付物、AI 无权修）
//      ⇒ 绝对 0 会让每次终验必败且无法修复 = 闸门变砖。
//   ③ [incremental] `only` 参数：重交只重跑上次失败段，其余记 skipped。
//      （原实现 `hasL2Record` 为真就整段跳过 → 修完重交什么都不验，终验形同虚设。）
//   ④ [level] L2 项标 `level: 'L2'`（原标 'L1'，在 `[SELF-FAIL]` 报告与台账里误导读者）。
import fs from 'node:fs'
import { runProcess } from '../process/proc.js'
import { getRoot } from '../config.js'
import { countTscErrors, loadBaseline } from './regression.js'
import { probeArtifacts } from './artifact-probe.js'
import type { CheckItem } from './executor.js'

// [selfcheck-l2-b2-v1] B2 隔离临时实例探针：**默认关，不实现（期三）**。
// [CONSTRAINT] 安全铁律（违反任一条即 B2 整体不交付）：
//   a. 禁止对运行中主实例（5175）做任何 build / 重启 / 文件替换；
//   b. 临时实例必须随机高端口（>49152）+ 独立 AIR_SERVER_PORT + 独立状态目录
//      .ai-runner/tmp/probe-<ts>/；detached 前记录 pid；
//   c. 探针结束必须杀净临时进程树（残留 → 守卫 G13 fail）；
//   d. 临时实例若需先 build 而 build 会重写共享 dist → 该路径不可实现，
//      降级为 B1 反查并在报告注明 probe-skipped: shared-dist。
// [CHANGE-IMPACT] 开关只作占位，runFullGate 不读它；期三实现时再接线。
export const L2_B2_ENABLED = false

/** [selfcheck-l2-budget-v2] 单段预算：求和上限由 T_TOTAL 收口，任何一段都不得吃掉全部预算 */
const T_VITEST = 540_000
const T_TSC = 150_000
const T_LINT = 120_000
/** 全门总预算：须 < hooks.ts 的 BeforeDoneFinal 超时（1200s），留 4 分钟余量给序列化与回传 */
const T_TOTAL = 960_000
/** 剩余预算低于此值即不再开新段（开了也大概率被 deadline 截断，不如明确 skipped） */
const MIN_SEGMENT = 30_000
const L2_TSCONFIGS = ['tsconfig.json', 'tsconfig.client.json', 'tsconfig.apps.json', 'tsconfig.test.json']

export interface L2Result {
  items: CheckItem[]
  degraded: boolean
  durationMs: number
  /** deadline 触发：有段因总预算耗尽未跑（须在报告里明说，不能静默） */
  deadlineHit: boolean
}

// [selfcheck-l2-deps-v1] 依赖注入入口：守卫测试 G8/G9 注入假计数器，不跑真子进程。
export interface FullGateDeps {
  vitestFailed?: (timeoutMs: number) => Promise<number>
  tscErrors?: (tsconfig: string, timeoutMs: number) => Promise<number>
  lintErrors?: () => Promise<number>
  /**
   * [selfcheck-l2-baseline-deps-v2] lint 存量基线（缺省读 .ai-runner/baseline.json）
   * 可注入的理由：仓库 baseline 恰为 0 时，「对 baseline」与「绝对 0」行为等价 →
   * 判据不可测（变异 M7 存活实测）。注入后能真正验「存量放行 / 只拦新增」。
   */
  baselineLint?: number
}

/** 增量重跑与 B1 范围的选项 */
export interface FullGateOpts {
  /** 只跑这些判据 id（= 上次失败项）；其余记 skipped。缺省 = 全跑 */
  only?: string[]
  /** B1 反查范围（DONE 声称集）；缺省回退 changed */
  claimed?: string[]
  /** DONE 是否声称已重建产物：为真则「产物未命中」升级为 fail（治造假），否则只作 warn */
  enforceFresh?: boolean
}

function mkItem(id: string, ok: boolean, actual: string, expected: string, details?: string[]): CheckItem {
  return { id, level: 'L2', ok, actual, expected, details }
}

function skipped(id: string, why: string): CheckItem {
  return mkItem(id, true, '命令/解析失败', '跳过', [`[skipped] ${why}`])
}

/** 增量模式下未列入 only 的段：明确标注「上次已过」，不与「跳过」混为一谈 */
function incrementalSkip(id: string): CheckItem {
  return mkItem(id, true, '上次已通过', '仅重验失败项', [`[skipped] 增量重验：本段上次已通过`])
}

function budgetSkip(id: string, usedMs: number): CheckItem {
  return mkItem(id, true, '总预算耗尽', '跳过', [`[skipped] 总预算 ${Math.round(usedMs / 1000)}s 已用尽，本段未跑`])
}

/**
 * 真实 vitest 计数（-1 = 命令/解析失败）
 * [CONSTRAINT] 不改用 `--reporter=basic`（实测 ERR_LOAD_URL）；json 报告落 tmp 后解析
 */
async function vitestFailedReal(timeoutMs: number): Promise<number> {
  const out = `${getRoot()}/.ai-runner/tmp/l2-vitest.json`
  const bin = `${getRoot()}/node_modules/.bin/vitest`
  await runProcess(bin, {
    args: ['run', '--reporter=json', `--outputFile=${out}`],
    cwd: getRoot(),
    timeoutMs,
    timeoutLabel: 'L2 vitest',
  })
  try {
    const j = JSON.parse(fs.readFileSync(out, 'utf8'))
    if (typeof j.numFailedTests === 'number') return j.numFailedTests
  } catch { /* parse fail */ }
  return -1
}

/**
 * 真实全仓 eslint 计数（-1 = 失败）
 * [selfcheck-l2-lint-scope-v2] 排除运行态目录：`.workbuddy/`（宿主记忆）与 `.ai-runner/`（运行产物）
 * 都不是交付物，且 AI 无权修改 → 纳入判据只会制造无法修复的失败。
 */
async function lintErrorsReal(): Promise<number> {
  const r = await runProcess(`${getRoot()}/node_modules/.bin/eslint`, {
    args: ['.', '--format', 'json', '--ignore-pattern', '.workbuddy/**', '--ignore-pattern', '.ai-runner/**'],
    cwd: getRoot(),
    timeoutMs: T_LINT,
    timeoutLabel: 'L2 eslint',
  })
  try {
    const j = JSON.parse(String(r.stdout || '[]'))
    if (Array.isArray(j)) return j.reduce((n: number, f: { errorCount?: number }) => n + (f.errorCount || 0), 0)
  } catch { /* parse fail */ }
  return -1
}

/** 该 id 是否需要在本次（可能是增量的）运行中执行 */
function shouldRun(only: Set<string> | null, id: string): boolean {
  return !only || only.has(id)
}

/** 主入口：串行跑四段；任一段 skipped/warn → degraded=true；degraded 由调用方决定是否拦 */
export async function runFullGate(changed: string[] = [], deps: FullGateDeps = {}, opts: FullGateOpts = {}): Promise<L2Result> {
  const start = Date.now()
  const vitestOf = deps.vitestFailed ?? vitestFailedReal
  const tscOf = deps.tscErrors ?? countTscErrors
  const lintOf = deps.lintErrors ?? lintErrorsReal
  const items: CheckItem[] = []
  const only = opts.only && opts.only.length ? new Set(opts.only) : null
  const remain = () => T_TOTAL - (Date.now() - start)
  let deadlineHit = false

  /** 开段前检查预算；返回可用超时（不足 MIN_SEGMENT 返回 null = 不跑） */
  const budgetFor = (want: number): number | null => {
    const left = remain()
    if (left < MIN_SEGMENT) return null
    return Math.min(want, left)
  }

  // —— 段 1：全量 vitest ——
  if (!shouldRun(only, 'L2-vitest')) {
    items.push(incrementalSkip('L2-vitest'))
  } else {
    const budget = budgetFor(T_VITEST)
    if (budget === null) { deadlineHit = true; items.push(budgetSkip('L2-vitest', Date.now() - start)) } else {
      const failed = await vitestOf(budget)
      items.push(failed < 0
        ? skipped('L2-vitest', 'vitest 无法取失败计数')
        : mkItem('L2-vitest', failed === 0, `${failed} failed`, '0 failed'))
    }
  }

  // —— 段 2：4×tsc 全跑（区别于 L1 的 pickTsTargets 子集） ——
  for (const t of L2_TSCONFIGS) {
    const id = `L2-tsc-${t}`
    if (!shouldRun(only, id)) { items.push(incrementalSkip(id)); continue }
    const budget = budgetFor(T_TSC)
    if (budget === null) { deadlineHit = true; items.push(budgetSkip(id, Date.now() - start)); continue }
    const n = await tscOf(t, budget)
    items.push(n < 0 ? skipped(id, `${t} 无法取错误数`) : mkItem(id, n === 0, `${n} errors`, '0 errors'))
  }

  // —— 段 3：全仓 eslint（对 baseline 只拦新增，排除运行态目录） ——
  if (!shouldRun(only, 'L2-lint')) {
    items.push(incrementalSkip('L2-lint'))
  } else {
    const budget = budgetFor(T_LINT)
    if (budget === null) { deadlineHit = true; items.push(budgetSkip('L2-lint', Date.now() - start)) } else {
      const lintN = await lintOf()
      const baseLint = Number(deps.baselineLint ?? loadBaseline()?.lint?.errors ?? 0)
      items.push(lintN < 0
        ? skipped('L2-lint', 'eslint 无法取错误数')
        : mkItem('L2-lint', lintN <= baseLint, `${lintN} errors`, `<= baseline ${baseLint} errors`, lintN <= baseLint ? undefined : [`新增 ${lintN - baseLint} 个 lint error（存量 ${baseLint} 放行）`]))
    }
  }

  // —— 段 4：B1 产物反查（默认仅 warn；声称已重建时为 fail 判据） ——
  const b1Id = 'B1-artifacts'
  if (!shouldRun(only, b1Id) && only && ![...only].some(id => id.startsWith('B1-'))) {
    items.push(incrementalSkip(b1Id))
  } else {
    const scope = opts.claimed && opts.claimed.length ? opts.claimed : changed
    items.push(...probeArtifacts(only ? scope.filter(p => only.has(`B1-${p}`)) : scope, { enforceFresh: opts.enforceFresh === true }))
  }

  // [selfcheck-l2-degraded-v2] degraded = 有段没跑成（skipped）或产物陈旧（warn）
  const degraded = items.some(i => (i.details || []).some(d => d.startsWith('[skipped]') || d.startsWith('[warn]')))
  return { items, degraded, durationMs: Date.now() - start, deadlineHit }
}
