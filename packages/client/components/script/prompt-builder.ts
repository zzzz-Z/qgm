// [prompt-builder-v1] 从 ScriptPanel.vue 抽出：AI prompt 拼装的 append* 系列
// 纯函数 + 结构类型；调用方传入数据，模块本身不做状态访问

import { buildErrorContext } from '../../utils/contextBuilder'
import { shouldIncludeChanges } from '../../composables/runner/useRunFeedback'
import { trimOutput } from './output-utils'

/** 变更条目（type: added / modified / deleted） */
export interface PromptChange { path: string, type: string }

/** 执行结果形状（只声明 append* 系列用到的字段） */
export interface PromptResult {
  ok: boolean
  code: number
  stderr?: string
  stdout?: string
  runId?: string
  baselineRunId?: string
  dryRunFailed?: boolean
  dryRunChangeCount?: number
  dryRunReason?: string
  wantChanges?: Array<{ type: string, path: string }>
  errorFiles?: string[]
  scriptCtx?: string
  smoke?: { ran: boolean, ok: boolean, error?: string, pages: Array<{ ok: boolean, url: string, errors: string[] }> } | null
  tsc?: { ok: boolean, stdout?: string, stderr?: string } | null
  lint?: { ran: boolean, ok: boolean, stdout?: string, stderr?: string } | null
  test?: { ran: boolean, ok: boolean, stdout?: string, stderr?: string } | null
  claimMismatch?: { claimed: string[], actual: string[], missing: string[], extra: string[] } | null
}

/** 错误位置（来自 parseErrorLocations 的返回） */
type ErrorLocs = ReturnType<typeof import('../../utils/contextBuilder').parseErrorLocations>

/** 预算裁剪：超预算时对「相关文件源码」块做二次裁剪；toast 由调用方传入 */
type ToastFn = typeof import('../../composables/ui/useToast').toast

/** 失败时把相关文件源码块追加到 prompt 数组（去重后取前 5 个路径） */
export async function appendFailedSourceFiles(
  p: string[],
  r: PromptResult | null,
  changes: PromptChange[],
  opts: { stripComments: boolean, stripBlankLines: boolean, errorLocs: ErrorLocs },
): Promise<void> {
  if (!r || r.ok) return
  const changedPaths = changes.filter(c => c.type !== 'deleted').map(c => c.path)
  const errorPaths = r.errorFiles ?? []
  const mergedPaths = [...new Set([...errorPaths, ...changedPaths])].slice(0, 5)
  if (mergedPaths.length === 0) return
  try {
    const res = await fetch('/__ai/files/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: mergedPaths }),
    })
    const data = await res.json()
    if (data.files?.length) {
      p.push('# 相关文件源码（失败时自动附加，含报错涉及的文件）')
      p.push(buildErrorContext(data.files, opts.errorLocs, {
        stripComments: opts.stripComments,
        stripBlankLines: opts.stripBlankLines,
      }))
      p.push('')
    }
  } catch (e) {
    p.push(`# ⚠️ 获取变更文件源码失败: ${String(e)}`)
    p.push('')
  }
}

/** 追加三层反馈摘要（行为层 → 类型层 → 代码层，含通过项） */
export function appendFeedbackSummary(p: string[], r: PromptResult | null): void {
  if (!r) return
  const issues: string[] = []
  const okLine: string[] = []
  if (r.test?.ran) {
    if (!r.test.ok) issues.push('行为层: 单测失败（见下 # 单元测试）')
    else okLine.push('test ✓')
  }
  if (r.smoke?.ran && !r.smoke.ok) issues.push('行为层: 冒烟失败（见下 # 页面冒烟）')
  if (r.dryRunFailed) issues.push('行为层: 脚本运行中断，磁盘零改动')
  if (r.code !== 0 && !r.dryRunFailed && r.code !== -1) {
    issues.push(`行为层: 退出码 ${r.code}`)
  }
  if (r.tsc) {
    if (r.tsc.ok === false) issues.push('类型层: tsc 报错（见下 # 类型检查）')
    else okLine.push('tsc ✓')
  }
  if (r.lint?.ran) {
    if (!r.lint.ok) issues.push('代码层: eslint 报错（见下 # 代码格式化）')
    else okLine.push('lint ✓')
  }
  p.push('# 三层反馈摘要')
  if (issues.length === 0) {
    p.push(`✓ 无阻塞问题${okLine.length ? `（${okLine.join(' / ')}）` : ''}`)
  } else {
    p.push('按优先级：')
    for (const i of issues) p.push(`- ${i}`)
    if (okLine.length) p.push(`已通过：${okLine.join(' / ')}`)
  }
  p.push('')
}

/** 追加变更文件列表（有变更时） */
export function appendChangeList(p: string[], changes: PromptChange[]): void {
  if (!changes.length) return
  p.push('# 变更')
  p.push('```')
  changes.forEach(c => p.push(`${c.type} ${c.path}`))
  p.push('```')
  p.push('')
}

/** 追加预检失败块（dryRunFailed 时） */
export function appendDryRunFailure(p: string[], r: PromptResult | null): void {
  if (!r?.dryRunFailed) return
  p.push('# ⚠ 预检失败：脚本未通过校验，磁盘零改动', '')
  p.push(`- 脚本本想改动 ${r.dryRunChangeCount ?? 0} 个文件，但执行中途失败，磁盘上没有任何变化`)
  p.push(`- 原因：${r.dryRunReason || '脚本运行时错误（非类型错误）'}`)
  if (r.wantChanges?.length) {
    p.push('- 脚本声称/尝试的改动：')
    for (const c of r.wantChanges.slice(0, 20)) p.push(`  - [${c.type}] ${c.path}`)
    if (r.wantChanges.length > 20) p.push(`  - ... 共 ${r.wantChanges.length} 个`)
  }
  p.push('- 请基于下方 stderr 定位根因，重新生成完整脚本；不要再给出会中途抛错的版本')
  p.push('')
}

/** 追加页面冒烟结果（smoke.ran 时） */
export function appendSmokeReport(p: string[], r: PromptResult | null): void {
  if (!r?.smoke?.ran) return
  p.push('# 页面冒烟')
  if (r.smoke.error) {
    p.push(`启动失败: ${r.smoke.error}`)
  } else {
    for (const pg of r.smoke.pages) {
      p.push(`${pg.ok ? '✓' : '✗'} ${pg.url}`)
      for (const e of pg.errors) p.push(`  ${e}`)
    }
  }
  p.push('')
}

/** 追加类型检查报告（tsc 时） */
export function appendTscReport(p: string[], r: PromptResult | null): void {
  if (!r?.tsc) return
  p.push('# 类型检查 (tsc)')
  p.push(r.tsc.ok ? '✓ 通过' : '✗ 存在类型错误')
  p.push('```')
  p.push((r.tsc.stdout || '') + (r.tsc.stderr ? `\n${r.tsc.stderr}` : ''))
  p.push('```')
  p.push('')
}

/** 追加 eslint 报告（lint.ran 且失败时） */
export function appendLintReport(p: string[], r: PromptResult | null): void {
  if (!r?.lint?.ran || r.lint.ok) return
  p.push('# 代码格式化 (eslint)')
  p.push('✗ 存在 lint 错误')
  p.push('```')
  p.push((r.lint.stdout || '') + (r.lint.stderr ? `\n${r.lint.stderr}` : ''))
  p.push('```')
  p.push('')
}

/** 追加单元测试报告（test.ran 且失败时） */
export function appendTestReport(p: string[], r: PromptResult | null): void {
  if (!r?.test?.ran || r.test.ok) return
  p.push('# 单元测试')
  p.push('✗ 存在测试失败')
  p.push('```')
  p.push((r.test.stdout || '') + (r.test.stderr ? `\n${r.test.stderr}` : ''))
  p.push('```')
  p.push('')
}

/** 追加跨轮累积变更（baselineRunId 存在且与当前 runId 不同时） */
export async function appendBaselineChanges(
  p: string[],
  r: PromptResult | null,
  errorLocs: ErrorLocs,
): Promise<void> {
  const baseline = r?.baselineRunId
  if (!r || !baseline || baseline === r.runId) return
  try {
    const res = await fetch('/__ai/diff-from-baseline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baselineRunId: baseline }),
    })
    const data = await res.json()
    const acc = data.changes || []
    if (acc.length && shouldIncludeChanges(acc, errorLocs)) {
      p.push(`# 跨轮累积变更（基准 ${baseline}）`)
      p.push('```')
      for (const c of acc) p.push(`${c.type} ${c.path}`)
      p.push('```')
      p.push('')
    }
  } catch { /* ignore */ }
}

/** 追加脚本声明 vs 实际改动差异块（claimMismatch 时） */
export function appendClaimMismatch(p: string[], r: PromptResult | null): void {
  const cm = r?.claimMismatch
  if (!cm) return
  if (cm.missing.length || cm.extra.length || !cm.actual.length) {
    p.push('# 脚本声明的改动 vs 实际改动')
    p.push(`声明：${cm.claimed.join(', ') || '（无）'}`)
    p.push(`实际：${cm.actual.join(', ') || '（无）'}`)
    if (cm.extra.length) p.push(`⚠ 未声明但改动：${cm.extra.join(', ')}`)
    if (!cm.actual.length) p.push('⚠ 脚本未产生任何文件改动')
    p.push('')
  }
}

/** 追加 stderr / stdout 原始输出块 */
export function appendRawOutputs(p: string[], r: PromptResult | null): void {
  if (!r) return
  if (r.stderr) p.push('# 错误输出 (stderr)', '```', trimOutput(r.stderr, r.ok, 3000, 12000, r.scriptCtx), '```', '')
  if (r.stdout) p.push('# Stdout', '```', trimOutput(r.stdout, r.ok, 3000, 12000, r.scriptCtx), '```', '')
}
