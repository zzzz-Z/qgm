// [selfcheck-executor-v1] 任务收尾自检执行器（L0 + L1）
// [WHY] 改动真实性只有服务端能证（磁盘/git/toolLog）；本模块是纯逻辑核心

export interface CheckItem {
  id: string
  level: 'L0' | 'L1' | 'L2'
  ok: boolean
  actual: string
  expected: string
  details?: string[]
}

export interface SelfcheckResult {
  verdict: 'pass' | 'fail'
  level: 'L0' | 'L0+L1'
  items: CheckItem[]
  degraded?: string
  durationMs: number
}

export interface DeclaredChange {
  path: string
  kind: string
}

/**
 * 解析 DONE 总结里的「变更文件」Markdown 表
 * [CONSTRAINT] 只认三列格式 path / kind / desc；表头/分隔行跳过
 * @param doneText DONE 回复全文
 */
export function parseDeclaredChanges(doneText: string): DeclaredChange[] {
  const out: DeclaredChange[] = []
  const lines = String(doneText || '').split('\n')
  let inTable = false
  for (const raw of lines) {
    const line = raw.trim()
    if (/^#{1,6}\s*变更文件\s*$/.test(line)) { inTable = true; continue }
    if (inTable && /^#{1,6}\s/.test(line)) break
    if (!inTable) continue
    if (!line.startsWith('|')) continue
    const cols = line.slice(1, -1).split('|').map(s => s.trim())
    if (cols.length < 2) continue
    if (/^:?-+$/.test(cols[1]) || /^:?-+$/.test(cols[0])) continue
    if (cols[0] === '文件' || cols[0] === 'path/to/file') continue
    out.push({ path: cols[0], kind: cols[1] })
  }
  return out
}

/**
 * 解析 DONE 总结里「验证结果」段声称跑过的命令
 * [CONSTRAINT] 只认列表项（- / * / 数字.）与代码块里以 pnpm / npm / npx / node / vitest / tsc / vue-tsc / eslint 开头的行
 * @param doneText DONE 回复全文
 */
export function parseDeclaredCommands(doneText: string): string[] {
  const out: string[] = []
  const lines = String(doneText || '').split('\n')
  let inSection = false
  let inFence = false
  for (const raw of lines) {
    const line = raw.trim()
    if (/^#{1,6}\s*验证结果\s*$/.test(line)) { inSection = true; continue }
    if (inSection && /^#{1,6}\s/.test(line)) break
    if (!inSection) continue
    if (line.startsWith('```')) { inFence = !inFence; continue }
    const body = inFence ? line : line.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '')
    if (!body) continue
    if (/^(?:pnpm|npm|npx|yarn|node|vitest|tsc|vue-tsc|eslint)\b/.test(body)) out.push(body)
  }
  return out
}

/**
 * 变更集对账：DONE 声称改动文件 vs 实测 changed 文件
 * [CONSTRAINT] 归一化路径按 POSIX 对比；声称但实测无 = fail
 */
export function reconcileChanges(declared: DeclaredChange[], actual: string[]): CheckItem {
  const norm = (s: string) => String(s || '').replace(/\\/g, '/').replace(/^\.\//, '').trim()
  const declaredSet = new Set(declared.map(d => norm(d.path)).filter(Boolean))
  const actualSet = new Set(actual.map(norm).filter(Boolean))
  const missing: string[] = []
  const extra: string[] = []
  for (const d of declaredSet) { if (!actualSet.has(d)) missing.push(d)
  }
  for (const a of actualSet) { if (!declaredSet.has(a)) extra.push(a)
  }
  // [selfcheck-subset-v1] 治造假语义 = claimed ⊆ actual：幽灵声称（声称但实测无）必拦；
  //   实测多于声称不拦——工作区常含历次循环未提交改动与运行态产物，DONE 只需对本轮
  //   改动负责（实测 2026-10-05：HEAD 起 194 项未提交改动，完全相等判据把每个正常 DONE 都拒成砖）。
  const ok = missing.length === 0
  const details: string[] = []
  for (const m of missing) details.push(`声称但实测无: ${m}`)
  if (extra.length) {
    details.push(`[info] 实测另有 ${extra.length} 项未声称（不拦截）: ${extra.slice(0, 5).join(', ')}${extra.length > 5 ? ' …' : ''}`)
  }
  return {
    id: 'L0-changeset',
    level: 'L0',
    ok,
    actual: `声称 ${declaredSet.size} / 实测 ${actualSet.size}`,
    expected: '声称项均真实存在（claimed ⊆ actual）',
    details: details.length ? details : undefined,
  }
}
/**
 * 命令对账：DONE 声称跑过的命令 vs toolLog 真实执行过的命令
 * [CONSTRAINT] 只比较首个 token；声称但观察到 0 条 = fail
 */
export function reconcileCommands(declared: string[], observed: string[]): CheckItem {
  const first = (s: string) => String(s || '').trim().split(/\s+/)[0] || ''
  const obsSet = new Set(observed.map(first).filter(Boolean))
  const missing: string[] = []
  for (const d of declared) {
    const t = first(d)
    if (!t) continue
    if (!obsSet.has(t)) missing.push(d)
  }
  return {
    id: 'L0-commands',
    level: 'L0',
    ok: missing.length === 0,
    actual: `声称 ${declared.length} / 观察到 ${obsSet.size}`,
    expected: '声称命令均可在 toolLog 找到',
    details: missing.length ? missing.map(m => `声称但未跑: ${m}`) : undefined,
  }
}
/**
 * 主入口：执行期一自检（L0）
 * [CONSTRAINT] 只做编排，具体对账逻辑在纯函数里（便于单测）
 * @param input 自检输入
 * @param input.doneText DONE 回复全文
 * @param input.actualChanges git 实测改动文件列表
 * @param input.observedCommands toolLog 观察到的命令列表
 */
/**
 * [selfcheck-degrade-v1] 超时降级标记：把已完成的 L0 结果标为降级（L1 未跑）
 * [CONSTRAINT] 保留 items 与 verdict，仅追加 degraded 与 level="L0"
 */
export function degradeResult(r: SelfcheckResult, reason: string): SelfcheckResult {
  return { ...r, level: 'L0', degraded: reason, durationMs: r.durationMs }
}

export function runSelfcheck(input: {
  doneText: string
  actualChanges: string[]
  observedCommands: string[]
}): SelfcheckResult {
  const start = Date.now()
  const items: CheckItem[] = []
  const declared = parseDeclaredChanges(input.doneText)
  const declaredCmds = parseDeclaredCommands(input.doneText)
  items.push(reconcileChanges(declared, input.actualChanges))
  items.push(reconcileCommands(declaredCmds, input.observedCommands))
  const verdict = items.every(i => i.ok) ? 'pass' : 'fail'
  return { verdict, level: 'L0', items, durationMs: Date.now() - start }
}
