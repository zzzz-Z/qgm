// [selfcheck-route-v1] POST /__ai/selfcheck：任务收尾自检（期一 L0）
// [WHY] 改动真实性只有服务端能证；端点与 hook 壳共享 executor 单点实现
// [selfcheck-failopen-v1] 语义：**矛盾必拦（fail-closed），缺证据不拦（fail-open）**
//   —— startCommit 缺失 / observedCommands 为空时该项记 skipped（ok=true + 说明），
//      绝不因证据缺失把正常 DONE 连拒两次熔断（那是把闸门变成砖）。
import { Hono } from 'hono'
import {

  parseDeclaredChanges,
  parseDeclaredCommands,
  reconcileChanges,
  reconcileCommands
} from '../selfcheck/executor.js'
import type { CheckItem } from '../selfcheck/executor.js'
import { runProcess } from '../process/proc.js'
import { loadBaseline, runRegression } from '../selfcheck/regression.js'
import { runFullGate } from '../selfcheck/fullgate.js'
import { appendLedger, lastL2Record } from '../selfcheck/ledger.js'
import { getRoot } from '../config.js'
import { discoverTargets } from '../headless/discover-targets.js'
import { computeSmokeReportCompliance } from '../post-run/run-compliance.js'

/** selfcheck 路由的 Hono 实例 */
export const selfcheckHono = new Hono()

/**
 * git 拿实测变更集（POSIX 归一化）= 已跟踪改动 + 未跟踪新文件 − 运行态排除项
 * [selfcheck-diff-scope-v1] 三条实测校准：
 *   ① 用单 ref `git diff --name-only <startCommit>`（startCommit vs 工作区）：循环期间改动不提交
 *     （回滚靠 startCommit），双 ref `<start>..HEAD` 会漏掉全部未提交改动，把正常 DONE 误判成
 *     「声称但实测无」；单 ref 同时覆盖已提交与未提交内容。
 *   ② `git diff` 不显示未跟踪文件 → 补 `git ls-files --others --exclude-standard`，否则新增文件
 *     全部「声称但实测无」。
 *   ③ 运行态文件（.workbuddy/ 记忆、.ai-runner/tmp/）不属于交付物，不进对账集，防误拒。
 *   无 startCommit 或 git 不可用时返回空数组
 */
const SELFCHECK_EXCLUDE_PREFIXES = ['.workbuddy/', '.ai-runner/tmp/']

async function gitChangedFiles(startCommit: string): Promise<string[]> {
  if (!startCommit) return []
  const opts = { cwd: getRoot(), timeoutMs: 10_000 }
  const tracked = await runProcess('git', {
    ...opts,
    args: ['diff', '--name-only', startCommit],
    timeoutLabel: 'selfcheck git diff',
  })
  if (tracked.code !== 0) return []
  const untracked = await runProcess('git', {
    ...opts,
    args: ['ls-files', '--others', '--exclude-standard'],
    timeoutLabel: 'selfcheck git untracked',
  })
  const all = [
    ...String(tracked.stdout || '').split('\n'),
    ...(untracked.code === 0 ? String(untracked.stdout || '').split('\n') : []),
  ]
  return all
    .map(s => s.trim())
    .filter(Boolean)
    .filter(p => !SELFCHECK_EXCLUDE_PREFIXES.some(pre => p.startsWith(pre)))
}

selfcheckHono.post('/selfcheck', async (c) => {
  const start = Date.now()
  let body: { loopId?: string, startCommit?: string, doneText?: string, runIds?: string[], observedCommands?: string[], final?: boolean, round?: number } | null = null
  try { body = await c.req.json() } catch { body = null }
  const doneText = String(body?.doneText || '')
  const startCommit = String(body?.startCommit || '')
  const observedCommands = Array.isArray(body?.observedCommands) ? body!.observedCommands.map(String) : []
  const loopId = String(body?.loopId || '')
  const isFinal = body?.final === true
  const roundNum = Number(body?.round || 0)

  const items: CheckItem[] = []
  // [selfcheck-single-diff-v1] gitChangedFiles 只算一次：下方 L1 复用同一份实测集
  //   （原实现对账一次、L1 又全量重算一次，双倍 git 成本）
  const actualChanges = startCommit ? await gitChangedFiles(startCommit) : []

  // —— 变更集对账：有 startCommit 才真对账 ——
  if (startCommit) {
    items.push(reconcileChanges(parseDeclaredChanges(doneText), actualChanges))
  } else {
    items.push({
      id: 'L0-changeset',
      level: 'L0',
      ok: true,
      actual: '未提供 startCommit',
      expected: '跳过对账（缺证据不拦）',
      details: ['[skipped] 缺 startCommit：无法取实测变更集，本次未对账'],
    })
  }

  // —— 命令对账：有 toolLog 证据才真对账（toolLog 保留后由调用方传入） ——
  const declaredCmds = parseDeclaredCommands(doneText)
  if (observedCommands.length > 0) {
    items.push(reconcileCommands(declaredCmds, observedCommands))
  } else {
    items.push({
      id: 'L0-commands',
      level: 'L0',
      ok: true,
      actual: `声称 ${declaredCmds.length} / 无证据`,
      expected: '跳过对账（缺证据不拦）',
      details: declaredCmds.length ? ['[skipped] 无 observedCommands 证据源，本次未对账'] : undefined,
    })
  }

  // —— L1 回归核验：仅当改动触碰 packages/* 或 apps/* 才真跑 ——
  const l1Items = await runRegression(actualChanges, loadBaseline())
  items.push(...l1Items)

  // —— L0 业务 app 验证段合规：DONE 是否引用了自动发现的业务 app 目标 ——
  // [discover-targets-v1] 取代「只验宿主 5175」的旧盲区；fail-open（漏验只降级不拒收）。
  try {
    const appTargets = await discoverTargets({})
    const smokeC = computeSmokeReportCompliance(doneText, appTargets)
    if (smokeC) {
      if (smokeC.missing.length) {
        items.push({
          id: 'L0-smoke-app',
          level: 'L0',
          ok: true,
          actual: `发现 ${appTargets.length} 个业务 app 目标，DONE 未引用 ${smokeC.missing.length} 个`,
          expected: 'DONE 验证段须引用各业务 app 目标（tag 或 host:port）',
          details: [`[warn] 漏验业务 app: ${smokeC.missing.map(m => `${m.tag} ${m.url}`).join(' / ')}`],
        })
      } else {
        items.push({ id: 'L0-smoke-app', level: 'L0', ok: true, actual: `DONE 已引用全部 ${appTargets.length} 个业务 app 目标`, expected: '通过', details: ['[info] 业务 app 验证段齐备'] })
      }
    }
  } catch {
    // 发现过程异常不阻断：保持 fail-open
  }

  // —— L2 终验轮：final=true → 全量；已有 L2 记录则**只重验上次失败项**（增量） ——
  // [selfcheck-l2-incremental-v2] 原实现 `hasL2Record` 为真就整段跳过 → 修完重交什么都不验，
  //   与 SYSTEM.md「重交只重验失败项」文案不符且闸门形同虚设。现按台账 last.failed 增量重跑。
  let level: 'L0+L1' | 'L0+L1+L2' = 'L0+L1'
  let l2Degraded = false
  let deadlineHit = false
  if (isFinal) {
    const prev = lastL2Record(loopId)
    if (prev && prev.failed.length === 0) {
      items.push({ id: 'L2-skipped', level: 'L2', ok: true, actual: '上次终验全绿', expected: '无需重跑', details: ['[skipped] 该循环终验已全绿，不重跑全量'] })
    } else {
      // [selfcheck-l2-b1-scope-v2] B1 只查「DONE 声称 ∩ 实测」的真交付文件：
      //   原实现拿整个工作区（实测 190+ 项遗留）→ 噪音大且与本轮无关
      const declaredPaths = parseDeclaredChanges(doneText).map(d => String(d.path || '').trim()).filter(Boolean)
      const b1Scope = declaredPaths.filter(p => actualChanges.includes(p))
      // [selfcheck-l2-b1-enforce-v2] 只有 DONE 声称跑过 build 时才把「产物未命中」当造假拦；
      //   否则 rebuild 归宿主侧，未重建属正常（判 fail 会让每次 DONE 必被拒 → 熔断）
      const claimedBuild = declaredCmds.some(c => /\b(?:pnpm|npm|yarn)\s+(?:run\s+)?build\b|build-all|vite\s+build|tsc\s+-p/.test(String(c)))
      const l2 = await runFullGate(actualChanges, {}, {
        only: prev ? prev.failed : undefined,
        claimed: b1Scope.length ? b1Scope : declaredPaths,
        enforceFresh: claimedBuild,
      })
      items.push(...l2.items)
      l2Degraded = l2.degraded
      deadlineHit = l2.deadlineHit
      level = 'L0+L1+L2'
    }
  }

  const failedIds = items.filter(i => !i.ok).map(i => i.id)
  const allOk = items.every(i => i.ok)
  const skipped = items.filter(i => (i.details || []).some(d => d.includes('[skipped]'))).length
  // [selfcheck-l2-degraded-v2] 三态：有实测失败 → fail；无失败但有段没跑成 → degraded（放行 + 显式可见）；
  //   全跑成且全过 → pass。把 degraded 判成 fail 会让 AI 收到无法修复的打回（期一 5s 超时熔断同族）。
  const anyDegraded = allOk && items.some(i => (i.details || []).some(d => d.startsWith('[skipped]') || d.startsWith('[warn]')))
  const verdict: 'pass' | 'degraded' | 'fail' = !allOk ? 'fail' : (anyDegraded ? 'degraded' : 'pass')
  appendLedger({ ts: Date.now(), loopId, round: roundNum, level, verdict, degraded: l2Degraded || skipped > 0, durationMs: Date.now() - start, failed: failedIds })
  return c.json({
    verdict,
    level,
    items,
    degraded: !allOk
      ? undefined
      : L2_DEGRADED_NOTE(deadlineHit, l2Degraded, skipped),
    durationMs: Date.now() - start,
  })
})

/** degraded 说明文案：把「为什么没全绿」说清，且明确它不拦（避免调用方误读成通过） */
function L2_DEGRADED_NOTE(deadlineHit: boolean, l2Degraded: boolean, skipped: number): string | undefined {
  const bits: string[] = []
  if (deadlineHit) bits.push('L2 总预算耗尽，部分段未跑')
  if (l2Degraded) bits.push('L2 有段未取得证据（含产物未重建）')
  if (skipped > 0) bits.push(`${skipped} 项缺证据已跳过`)
  if (!bits.length) return undefined
  return `${bits.join('；')}（degraded：不拦，但不算全绿）`
}
