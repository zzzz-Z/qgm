// [prompt-builder-v1] 从 ScriptPanel.vue 抽出：AI prompt 拼装的 append* 系列
// 纯函数 + 结构类型；调用方传入数据，模块本身不做状态访问

// [explicit-imports-v1] buildErrorContext / shouldIncludeChanges 原先靠 auto-import 提供：
//   app 能跑，但 tsconfig.test.json 没有该插件 —— 本模块一旦被测试 import 就报
//   `Cannot find name`（AGENTS.md 已把这条列为项目独有约束）。改为显式 import 消除隐患。
import { buildErrorContext, capFilesByBudget } from '../../utils/contextBuilder'
import { shouldIncludeChanges } from '../../composables/runner/useRunFeedback'

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
  /** [L4b] 服务端用 TS AST 还原的失败定位（文件 + 行号 + 所属符号） */
  fingerprints?: Array<{ file: string, line: number, symbol: string, kind: string }>
  scriptCtx?: string
  /** [truncation-detect-v1] 服务端判定「脚本在尾部被上游截断」（仅 4xx 前置拦截时有值） */
  truncated?: boolean
  /**
   * [truncation-detect-v1] 服务端收到的脚本体积与 §10 预算比对结果
   * [budget-feedback-v1] 正常执行轮也有值（服务端每轮下发），供 appendBudgetNotice 做每轮配额反馈
   */
  scriptSize?: { lines: number, bytes: number, overBudget: boolean, maxLines: number, maxBytes: number }
  smoke?: { ran: boolean, ok: boolean, error?: string, pages: Array<{ ok: boolean, url: string, errors: string[], tag?: string }> } | null
  tsc?: { ok: boolean, stdout?: string, stderr?: string } | null
  lint?: { ran: boolean, ok: boolean, stdout?: string, stderr?: string } | null
  test?: { ran: boolean, ok: boolean, stdout?: string, stderr?: string, reason?: 'no-test-targets' } | null
  claimMismatch?: { claimed: string[], actual: string[], missing: string[], extra: string[] } | null
}

/** 错误位置（来自 parseErrorLocations 的返回） */
type ErrorLocs = ReturnType<typeof import('../../utils/contextBuilder').parseErrorLocations>

/**
 * [fence-safe-v1] 计算包裹 body 所需的反引号围栏：内容里最长反引号串长度 + 1（最少 3）
 * [WHY] 固定三反引号围栏会被**内容自身**撑破：脚本 stdout / 源码 / tsc·eslint·test 输出里含
 *   ``` 时围栏在内容中途提前闭合，后半段落成**普通文本**（不再是 `<pre><code>`）⇒ 页面内探针
 *   扫到自己的工作语言（被 dump 的源码里就有探针自己的词表）⇒ 误报「AI 会话已达长度上限」
 *   并掐掉一整轮（2026-10-10 12:02 实锤）。加长围栏后内容整体留在同一个代码块内。
 * [CONSTRAINT] 内容里没有反引号时仍产出 ```（保持既有 prompt 形态，AI 侧无感）。
 * [CONSTRAINT] 只加长围栏、不改内容——转义/替换内容会破坏 AI 要读的源码与行号契约。
 */
export function fenceFor(body: string): string {
  let longest = 0
  for (const run of String(body ?? '').match(/`+/g) || []) {
    if (run.length > longest) longest = run.length
  }
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * [fence-safe-v1] 原地追加一个围栏块（围栏长度按内容自适应，见 `fenceFor`）
 * [CONSTRAINT] 围栏行必须独占一行：push 进数组后由 `join('\n')` 保证，调用方不得把围栏与其它字符拼在一行
 */
export function pushFenced(p: string[], body: string): void {
  const fence = fenceFor(body)
  p.push(fence)
  p.push(body)
  p.push(fence)
  p.push('')
}

/** [prompt-source-budget-v1] 构建产物路径：对诊断无价值，直接不进 prompt */
const BUILD_ARTIFACT_RE = /\/(?:dist|build|\.turbo|\.vite|coverage)\//

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
      // [prompt-source-budget-v1] 先过滤构建产物、再按总预算裁剪：实测 dist/interceptor.cjs（587 行）
      //   曾让单条 prompt 达 24.8KB。产物由源码同步生成（runtime-cjs-copy 守卫），对诊断无价值。
      const raw = data.files as Array<{ path: string, content: string, error?: string }>
      const realFiles = raw.filter(f => !BUILD_ARTIFACT_RE.test(String(f.path)))
      const dropped = raw.length - realFiles.length
      const { files: cappedFiles, truncated } = capFilesByBudget(realFiles)
      p.push('# 相关文件源码（失败时自动附加，含报错涉及的文件）')
      if (dropped > 0) p.push(`> 已过滤 ${dropped} 个构建产物（dist/build），它们由源码同步生成，无需诊断`)
      if (truncated.length > 0) p.push(`> 超出体积预算已截首尾：${truncated.join(', ')}（需要全文请用 readText）`)
      // [fence-safe-v1] 本段原先**无围栏**（直接 push buildErrorContext 的 `<file path=…>` 块）⇒
      //   落进会话是**普通文本**，页面内探针扫得到被 dump 的源码（其中就有探针自己的触顶词表）
      //   ⇒ 自指误报（Channel D）。加围栏后整段落进 `<pre><code>`，探针剥壳即看不见。
      // [CONSTRAINT] `<file path=…>` 与 `N| ` 行号逐字符不变——它们是 AI 侧解析契约，只加外壳不动内容。
      pushFenced(p, buildErrorContext(cappedFiles, opts.errorLocs, {
        stripComments: opts.stripComments,
        stripBlankLines: opts.stripBlankLines,
      }))
    }
  } catch (e) {
    p.push(`# ⚠️ 获取变更文件源码失败: ${String(e)}`)
    p.push('')
  }
}

/**
 * 追加 AST 级失败定位（fingerprints 非空时）
 * [WHY] errorFiles 只给路径 —— 行号在服务端 extractErrorFiles 的正则里被显式丢弃；
 *   fingerprints 由 fingerprintErrors 走 TS AST 还原出「文件:行 → 所属符号」，
 *   让 AI 无需自行解析 stderr 即可直达出错函数，省掉一轮「先定位再改」的往返。
 * [CONSTRAINT] 仅失败轮有值；空数组不产出块（避免成功轮被无意义章节占预算）
 */
export function appendFingerprints(p: string[], r: PromptResult | null): void {
  const fps = r?.fingerprints
  if (!fps || fps.length === 0) return
  p.push('# 失败定位（AST 指纹）')
  p.push('| 文件 | 行 | 所属符号 | 类别 |')
  p.push('| :--- | ---: | :--- | :--- |')
  for (const f of fps) p.push(`| ${f.file} | ${f.line} | \`${f.symbol}\` | ${f.kind} |`)
  p.push('')
}

/**
 * [budget-feedback-v1] 单轮体积的「预警线」比例
 * [WHY] §10 的 300 行 / 12 KB 是**非拦截闸门**：超限只留痕不拦截，但它是最可靠的确定性
 *   安全工作区（在此之内一定不因体积被截），撞到该体积已站在截断边缘；
 *   预警线取安全工作区的 70%（≈210 行 / 8.4 KB），在还来得及收窄时就提示。
 * [CONSTRAINT] 必须 < 1.0，否则「预警」与「超预算」两档合并，退化成永不触发的死分支。
 */
export const BUDGET_WARN_RATIO = 0.7

/**
 * 追加「本轮输出体积」块（服务端实测值，供下一轮规划）
 * [WHY] AI 无法测量自己的输出长度——它看不到 token 计数，也数不准自己写了多少行。
 *   只在被截断时才告知体积，等于永远事后补救（撞了墙才知道墙在哪）；每轮把实测值带回
 *   决策回路，它才能在动手前判断「这轮还能加多少」，而不是写完才发现超了。
 * [CONSTRAINT] 仅 `runId` 非空（脚本**真跑过**）时产出：前置拦截轮（无 runId）的体积
 *   由 appendScriptInvalid 说明——那是「为什么被截断」的因果解释，两处输出体积会互相重复。
 * [CONSTRAINT] 只报可测的量（脚本块 S），**不给基于 S 的行动建议**——§10 的约束是 T + S ≤ B，
 *   而 T 服务端测不到 ⇒ 任何「还能写多少」的结论都缺依据（曾是判据真空，见 budget-notice-honest-v1）。
 */
export function appendBudgetNotice(p: string[], r: PromptResult | null): void {
  const sz = r?.scriptSize
  if (!r || !r.runId || !sz) return
  const ratio = Math.max(sz.lines / sz.maxLines, sz.bytes / sz.maxBytes)
  const pct = Math.round(ratio * 100)
  const kb = sz.bytes / 1024
  const maxKb = Math.round(sz.maxBytes / 1024)
  p.push('# 本轮输出体积（服务端实测）')
  p.push(`- 上一轮脚本块：${sz.lines} 行 / ${kb.toFixed(1)} KB`)
  p.push(`- §10 安全工作区（非闸门）：${sz.maxLines} 行 / ${maxKb} KB；含 patchFile 的 find/replace 合计 >150 行时尾段易截断`)
  p.push(`- 脚本块占安全工作区 ${pct}%。**此比例不含思考量 T**（§10 约束是 T + S ≤ B，服务端测不到 T）⇒ 无法据此判断剩余预算`)
  if (sz.overBudget) {
    p.push(`- ⚠ 上一轮脚本块**已超安全工作区**：它能完整到达属于侥幸`)
  }
  p.push('')
}

/** 追加三层反馈摘要（行为层 → 类型层 → 代码层，含通过项） */
export function appendFeedbackSummary(p: string[], r: PromptResult | null): void {
  if (!r) return
  const issues: string[] = []
  const okLine: string[] = []
  // [test-skip-reason-v1] 「没跑」与「跑了且通过」必须可区分：前者沉默会让人以为行为层已验过
  const notes: string[] = []
  if (r.test?.ran) {
    if (!r.test.ok) issues.push('行为层: 单测失败（见下 # 单元测试）')
    else okLine.push('test ✓')
  } else if (r.test?.reason === 'no-test-targets') {
    notes.push('本轮未运行单测（无测试目标）')
  }
  if (r.smoke?.ran && !r.smoke.ok) issues.push('行为层: 冒烟失败（见下 # 页面冒烟）')
  if (r.dryRunFailed) issues.push('行为层: 脚本运行中断，磁盘零改动')
  // [truncation-detect-v1] 4xx 且无 runId = 服务端在**执行前**拦下的。
  // 报「退出码 400」会让 AI 以为是运行时失败、去翻一个根本不存在的运行日志；
  // 真正的原因由 appendScriptInvalid 单独成块说明。
  const preflightBlocked = !r.runId && r.code >= 400
  if (preflightBlocked) {
    issues.push('行为层: 脚本未通过前置校验，服务端未执行（见下「脚本未通过前置校验」）')
  } else if (r.code !== 0 && !r.dryRunFailed && r.code !== -1) {
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
  if (notes.length) p.push(`说明：${notes.join('；')}`)
  p.push('')
}

/** 追加变更文件列表（有变更时） */
export function appendChangeList(p: string[], changes: PromptChange[]): void {
  if (!changes.length) return
  p.push('# 变更')
  pushFenced(p, changes.map(c => `${c.type} ${c.path}`).join('\n'))
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
      const tag = pg.tag && pg.tag !== 'host' ? `[${pg.tag}] ` : ''
      p.push(`${pg.ok ? '✓' : '✗'} ${tag}${pg.url}`)
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
  pushFenced(p, (r.tsc.stdout || '') + (r.tsc.stderr ? `\n${r.tsc.stderr}` : ''))
}

/** 追加 eslint 报告（lint.ran 且失败时） */
export function appendLintReport(p: string[], r: PromptResult | null): void {
  if (!r?.lint?.ran || r.lint.ok) return
  p.push('# 代码格式化 (eslint)')
  p.push('✗ 存在 lint 错误')
  pushFenced(p, (r.lint.stdout || '') + (r.lint.stderr ? `\n${r.lint.stderr}` : ''))
}

/** 追加单元测试报告（test.ran 且失败时） */
export function appendTestReport(p: string[], r: PromptResult | null): void {
  if (!r?.test?.ran || r.test.ok) return
  p.push('# 单元测试')
  p.push('✗ 存在测试失败')
  pushFenced(p, (r.test.stdout || '') + (r.test.stderr ? `\n${r.test.stderr}` : ''))
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
      // [CONSTRAINT] 回调形参必须显式标注：acc 来自 res.json()（any），
      //   `for...of` 时代隐式 any 不报，改 `.map()` 后会触发 TS7006（tsc:client / test:tsc 双红）
      pushFenced(p, acc.map((c: PromptChange) => `${c.type} ${c.path}`).join('\n'))
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

// [trim-output-inlined-v1] 原 trimOutput 已是恒等函数，内联后删除 output-utils.ts
/**
 * [raw-output-budget-v1] stdout / stderr 进 prompt 前的体积预算（字节）。
 * [WHY] 服务端 run.ts:384-385 已把 summary 帧的 stdoutTail/stderrTail 截到 2000/4000，
 *   但前端 useRunner.ts:580 用 `liveStdout.value || s.stdoutTail` —— liveStdout 是流式累积的
 *   完整输出、无上限，服务端截断被完全绕过。实测单条 prompt 达 25.5KB（成功轮，非失败轮附加源码）。
 * [CONSTRAINT] 与 §10 脚本预算（12KB）同量级，保证「输入 + 输出」总量可控。
 *   `@ctx: full` 是用户在脚本头显式声明的「我要看全量」，此时跳过截断（与服务端 run.ts 判据一致）。
 */
export const RAW_OUTPUT_MAX_BYTES = { stdout: 2000, stderr: 4000 }

/**
 * 按字节预算截尾，并在头部标注省略量。
 * [CONSTRAINT] 多字节字符按比例折算会略超预算，量级正确即可——目的是防止数量级膨胀，不是精确限额。
 * @param text 原文
 * @param maxBytes 字节上限
 */
function capTail(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text).length
  if (bytes <= maxBytes) return text
  const keep = Math.max(200, Math.floor(text.length * (maxBytes / bytes)))
  const omitted = text.length - keep
  return `... [已省略前 ${omitted} 字符 / 共 ${text.length} 字符；需要全文请用 readText 或 --ctx:full 重跑]\n${text.slice(-keep)}`
}

/** 追加 stderr / stdout 原始输出块（[raw-output-budget-v1] 超预算截尾，@ctx: full 跳过） */
export function appendRawOutputs(p: string[], r: PromptResult | null): void {
  if (!r) return
  const keepFull = r.scriptCtx === 'full'
  if (r.stderr) {
    p.push('# 错误输出 (stderr)')
    pushFenced(p, keepFull ? r.stderr : capTail(r.stderr, RAW_OUTPUT_MAX_BYTES.stderr))
  }
  if (r.stdout) {
    p.push('# Stdout')
    pushFenced(p, keepFull ? r.stdout : capTail(r.stdout, RAW_OUTPUT_MAX_BYTES.stdout))
  }
}

/**
 * 从 4xx 响应体里取出人类可读的错误描述
 * [WHY] 前置拦截的 stderr 形如 `HTTP 400 Bad Request` + 换行 + `{"error":"脚本语法错误：…"}`；
 *   直接贴首行只会让 AI 看到 "HTTP 400"，真正的判据（哪种语法错）反而被淹掉。
 * [CONSTRAINT] 纯字符串处理，不做完整 JSON 解析（响应体可能被代理截断成半截 JSON）
 * @param stderr 客户端拼装的 stderr 文本
 */
function extractErrorLine(stderr: string | undefined): string {
  const lines = String(stderr || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const jsonish = lines.find(l => l.includes('"error"'))
  if (jsonish) {
    const m = /"error"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(jsonish)
    if (m) return m[1].replace(/\\"/g, '"').replace(/\\n/g, ' ')
  }
  return lines[1] || lines[0] || '（无错误详情）'
}

/**
 * 追加「脚本未通过前置校验」块（服务端 4xx 拦截：语法错误 / 脚本头契约违规 / 被截断）
 * [WHY] 这是**唯一**告知 AI「脚本根本没执行」的地方。原有 append* 系列全部面向「跑过一轮」的场景：
 *   4xx 只会落进 appendRawOutputs 的一段裸 HTTP 文本，于是 AI 把截断误读成运行失败、
 *   原地重发同样长的脚本、再次被截断，两轮后触发熔断冻结。
 * [CONSTRAINT] 仅 `runId` 为空且 `code >= 400` 时产出（即真正的前置拦截，而非运行中途失败）；
 *   truncated 分支的措辞必须是「通道故障 + 拆小重发」，**不得**出现「重新生成完整脚本」式规劝
 * @param p prompt 行数组（原地追加）
 * @param r 运行结果
 */
export function appendScriptInvalid(p: string[], r: PromptResult | null): void {
  if (!r || r.runId || r.code < 400) return
  p.push('# ⚠ 脚本未通过前置校验（服务端已拦截：脚本未执行，磁盘零改动）')
  if (r.truncated) {
    p.push('**判定：本轮脚本在尾部被上游截断 —— 这是输出通道故障，不是你的逻辑错误。**')
    p.push(`- 服务端收到的脚本在尾部被切断：${extractErrorLine(r.stderr)}`)
    if (r.scriptSize) {
      const kb = (r.scriptSize.bytes / 1024).toFixed(1)
      p.push(
        `- 到达体积：${r.scriptSize.lines} 行 / ${kb} KB`
        + `（§10 安全工作区 ${r.scriptSize.maxLines} 行 / ${Math.round(r.scriptSize.maxBytes / 1024)} KB，非拦截闸门）`,
      )
      p.push(r.scriptSize.overBudget
        ? '- ⚠ 到达体积**已超预算**：这一轮本就输出不完，与任务难度无关，纯粹是单轮太长'
        : '- 到达体积未超预算：说明本轮恰好卡在安全工作区边缘，下一轮务必留出余量')
    }
    p.push('')
    p.push('请这样做（**不要原地重试**）：')
    p.push('1. **禁止**重发同样长度的脚本——同样长度必然再次被切断，只是白烧一轮')
    p.push('2. 把本轮改动**拆成多个小脚本**：一条回复里可以给出多个代码块，它们会被**串行**执行')
    p.push('3. 每个脚本只推进一个原子步骤，**建议 ≤ 150 行**（给安全工作区留出至少一半余量）')
    p.push('4. 若前几个块已成功落盘，只重发**尚未完成**的部分，不要从头再来')
  } else {
    p.push('**判定：脚本语法/契约不合法，服务端在解析阶段就拦下了它（未执行）。**')
    p.push(`- 原因：${extractErrorLine(r.stderr)}`)
    p.push('- 请修正后重新生成；不要假设部分改动已落盘——磁盘零改动')
  }
  p.push('')
}
