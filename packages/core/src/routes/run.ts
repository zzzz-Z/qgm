// [arch-hono/run-v1] POST /run —— node 沙盒 / shell 脚本执行（NDJSON 流式；Hono 版）
// [g2-deadcode-cleanup-v1] G2 收窄后仅保留 node 脚本路径：bash 分支与 shell:true 的 runProcess 分支已删除
import { Hono } from 'hono'
import { SCRIPT_TIMEOUT_MS } from '../process/timeouts.js'
import {
  applyOverlay,
  buildRejectEntry,
  checkScriptSyntax,
  computeClaimMismatch,
  computeCompliance,
  diffMeta,
  discoverTargets,
  ensureDirs,
  extractErrorFiles,
  fingerprintErrors,
  gcSnapshots,
  getRoot,
  getWorkspace,
  gitCommitAfter,
  gitSnapshot,
  hasEslint,
  hashRules,
  measureScriptSize,
  parseClaimed,
  parseDecisionMarkers,
  parseScriptMeta,
  pickDeadLetterWrites,
  pickLintTargets,
  pickTscTargets,
  readOverlayChanges,
  readToolLogWithRetry,
  reapStaleTmp,
  recordReject,
  resetRejectStreak,
  runDir,
  runEslint,
  runScript,
  runSmokeTargets,
  runTests,
  runTsc,
  runWithWorkspace,
  saveIndex,
  saveIndexBefore,
  saveSnapshot,
  scanIndex,
  scanMeta,
  scanScriptHead,
  snapshot,
  splitShebang,
  writeRunLog,
} from '../deps.js'
import type { Change, ClaimMismatch, LintResult, SmokeResult } from '../deps.js'
import { createPipeline, markFailed, markOk, markRunning } from '../state/pipeline.js'
// [control-log-v1] 前置拒收留痕（详见 routes/control-log.ts）；
// [hclc-fix] buildRejectEntry 经 deps barrel 引入——直连会使本文件唯一模块数达 9（>8 阻断）
import { hashScript, writeRoundSnapshot } from '../state/timeline.js'
import { appendJsonlCapped, writeChannelLog } from '../state/snapshot.js'
import { checkSlow, deserialize, recordSample, serialize } from '../state/perf.js'
import fs from 'node:fs'
import path from 'node:path'

interface RunBody {
  script?: string
  gitCommit?: boolean
  gitVerify?: boolean
  sandbox?: string
  loopCtx?: { loopId?: string, round?: number, max?: number }
  sessionId?: string
  // [multi-workspace-v1] 目标工作区 id；缺省 = 活跃工作区。注册表外 id 返回 404
  workspaceId?: string
  smoke?: boolean
}

/** run 路由的 Hono 实例 */
export const runHono = new Hono()

runHono.post('/run', async (c) => {
  const startedAt = Date.now()
  const pipeline = createPipeline()
  const body = (await c.req.json().catch(() => null)) as RunBody | null
  // [multi-workspace-v1] 工作区解析：body.workspaceId 优先，缺省用活跃工作区；
  //   整条执行链包进 ALS 作用域——脚本 cwd、overlay、post-run tsc/lint/测试、快照与日志
  //   全部按目标工作区 root 解析，多工作区并发执行互不串台（getRoot 消费点零改动）。
  // [CONSTRAINT] ReadableStream.start 在构造时同步调用、await 延续保留 ALS 上下文，
  //   因此作用域建立一次即可覆盖流内全部阶段。
  const wsId = String(body?.workspaceId || '')
  if (wsId && !getWorkspace(wsId)) {
    return c.json({ error: `工作区不存在：${wsId}` }, 404)
  }
  return runWithWorkspace({ workspaceId: wsId || null, root: getWorkspace(wsId)?.root ?? getRoot() }, async () => {
    ensureDirs()
    fs.mkdirSync(path.join(getRoot(), '.ai-runner/tmp'), { recursive: true })
    // [tmp-reaper-v1] 清理过期运行产物（默认 7 天）；触发点随 /run 入口，无定时器
    reapStaleTmp()
    const sandboxRaw = String(body?.sandbox || 'read-only')
    let sandbox = ['read-only', 'workspace-write', 'full'].includes(sandboxRaw) ? sandboxRaw : 'read-only'
    const script = String(body?.script || '').trim()
    try {
      if (parseScriptMeta(script).mode === 'diff') sandbox = 'read-only'
    } catch { /* ignore */ }
    const gitCommit = Boolean(body?.gitCommit)
    // [tasks-api-sid-v1] 会话 id 由客户端经 /run 传入，服务端注入沙箱 env 供 __AI__.tasks 分桶用
    // [CONSTRAINT] 沙箱脚本不自传 sid（防伪造/串台）
    // [control-log-v1] 上移到前置拦截之前：三条拒收留痕都要带 sid，否则「哪个会话老在被截断」不可分桶
    const sessionId = String(body?.sessionId || '')
    const gitVerify = Boolean(body?.gitVerify)
    // [control-log-v1] /run 的三条前置拒收此前**零留痕**（4xx 发生在 NDJSON 流开始之前，
    //   写不进按流写的 runner.jsonl），而它们正是「脚本被截断」这一最高频故障的唯一现场：
    //   频率 / 体积分布 / 所属 sid / 是截断还是真语法错，全靠这条日志才可测。详见 routes/control-log.ts。
    const logReject = (script: string, kind: 'empty' | 'head-contract' | 'syntax', extra: { reason?: string, error?: string, truncated?: boolean, sizeScope?: 'raw' | 'effective' } = {}) => {
      const entry = buildRejectEntry(script, kind, { sid: sessionId, ...extra })
      writeChannelLog('reject', entry)
      // [reject-breaker-v1] 同 sid 同 kind 连续 >=2 次即熔断（tripped 时供客户端 finish）
      const verdict = recordReject(sessionId, kind)
      // 同时落进程 stderr：宿主 tail prod-server.log 即可看到「这一轮没执行」的原因，不必翻 jsonl
      console.warn(`[ai-runner][reject] kind=${entry.kind} bytes=${entry.bytes} lines=${entry.lines} overBudget=${entry.overBudget} truncated=${entry.truncated === true} sid=${entry.sid || '-'} streak=${verdict.count}${verdict.tripped ? ' BREAKER-TRIPPED' : ''}${entry.reason ? ` reason=${entry.reason}` : ''}${entry.error ? ` error=${entry.error}` : ''}`)
      return verdict
    }
    if (!script) {
      const v = logReject('', 'empty')
      return c.json({ error: '脚本为空', breaker: v.tripped }, v.tripped ? 429 : 400)
    }

    // [g2-narrow-v1] 脚本头契约前置拦截（先于 splitShebang 与语法检查）
    const head = scanScriptHead(script)
    if (!head.ok) {
      // [script-lang-whitelist-v2] ILLEGAL_SHEBANG 面向用户补一句可操作提示：
      //   采集侧白名单保留 bash（供自动循环 /exec），但 /run 只执行 node 脚本 ——
      //   不说明出路时，用户只会看到一串裸 reason，误以为「系统坏了」。
      // [CONSTRAINT] reason 在 HeadResult 里是可选的（非判别联合），取本地量避免 TS18048
      // [head-desc-hint-v1] MISSING_DESC/MISSING_WHY 与 top-await-hint-v1 同理：裸 reason 不给出路时，
      //   AI 只会换个写法再撞同一堵墙（2026-10-20 实测 subagent 探针连撞多次，head 全无 @desc/@why）。
      const reason = head.reason || '未知的脚本头契约违规'
      const hint = reason.startsWith('ILLEGAL_SHEBANG')
        ? '（/run 仅执行 node 脚本；bash 请改用自动循环或 `!` 命令行通道）'
        : reason === 'MISSING_DESC' || reason === 'MISSING_WHY'
          ? '（脚本头需带契约注释，两行缺一不可：`// @desc 一句话描述本脚本做什么` 和 `// @why 为什么此刻要跑`；普通编号注释如 `// 1. 提交` 不算）'
          : ''
      const v = logReject(script, 'head-contract', { reason })
      return c.json({
        error: `脚本头契约违规：${reason}${hint}`,
        metaError: true,
        rule: 'SYSTEM.md',
        // [reject-size-visible-v1] 与 syntax 分支同口径回传体积：AI 被 MISSED_DESC 拒时，
        //   同样需要知道「这一轮本来就已经超预算」，否则只会反复重发同长度的脚本。
        scriptSize: measureScriptSize(script),
        breaker: v.tripped,
      }, v.tripped ? 429 : 400)
    }
    const { isNodeScript, effectiveScript } = splitShebang(script)
    if (isNodeScript) {
      const syntax = checkScriptSyntax(effectiveScript)
      if (!syntax.ok) {
        // [truncation-detect-v1] 分流「通道故障」与「写错了」：
        //   截断（上游 max_tokens 切断尾部）不该被当成可重试的逻辑失败——
        //   原实现只回 `脚本语法错误`，客户端把它渲染成「退出码 400」，
        //   AI 于是原地重发同样长的脚本，必然再次被截断，两轮后熔断冻结。
        //   truncated=true 让客户端改发「缩小本轮范围、拆成多个小脚本」的指令。
        //   scriptSize 是判断「本轮本来就超预算」的唯一线索（到达体积已接近 12 KB）。
        const v = logReject(effectiveScript, 'syntax', {
          error: syntax.error,
          truncated: syntax.truncated === true,
          // 与响应体里的 scriptSize 同口径（都量 effectiveScript）：两处数字必须可比
          sizeScope: 'effective',
        })
        // [top-await-hint-v1] 顶层 await 是 /run 最高频的「原地重试陷阱」（2026-10-06 实测两个会话连踩 5+ 次）：
        //   脚本按 CJS 形态加载，顶层 await 必然语法错误；裸报错不给出路时 AI 只会换个写法再撞同一堵墙。
        const topAwaitHint = /await is only valid in async/.test(syntax.error || '')
          ? '。/run 脚本不支持顶层 await：请把异步逻辑包进 `;(async () => { ... })()` 再提交'
          : ''
        return c.json({
          error: `脚本语法错误：${syntax.error}${topAwaitHint}`,
          syntaxError: true,
          truncated: syntax.truncated,
          scriptSize: measureScriptSize(effectiveScript),
          breaker: v.tripped,
        }, v.tripped ? 429 : 400)
      }
    }

    // [script-timeout-relax-v1] 上限同源于 process/timeouts.ts（原 60s 会腰斩全量测试/构建类任务）

    const enc = new TextEncoder()
    const ac = new AbortController()
    // [abort-listener-trace-v1] 原为静默 catch：客户端断连时若 addEventListener 失败，
    //   脚本仍会跑满 180s（ac.signal 永不被触发），且全程无日志可查「为什么断连没中止」。
    try { c.req.raw.signal.addEventListener('abort', () => ac.abort()) }
    catch (e) { console.warn('[run] abort listener 绑定失败（断连不会中止脚本）:', String(e)) }
    const url = new URL(c.req.url)
    const proto = url.protocol === 'https:' ? 'https' : 'http'
    const host = c.req.header('host') || 'localhost:5173'

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const writeFrame = (frame: unknown) => {
          try { controller.enqueue(enc.encode(`${JSON.stringify(frame)}\n`)) } catch { /* ignore */ }
        }

        const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        // [run-dedup-calls-v1] hashRules 在同一次运行内不变；提前算一次供 round snapshot 与 compliance 复用
        const rv = hashRules()
        const overlayPath = path.join(getRoot(), '.ai-runner/tmp', `${runId}-overlay.json`)
        const toolLogPath = path.join(getRoot(), '.ai-runner/tmp', `${runId}-tools.jsonl`)
        try { fs.unlinkSync(overlayPath) } catch { /* ignore */ }
        try { fs.unlinkSync(toolLogPath) } catch { /* ignore */ }
        let gitInfo: { commit?: string, changed: number, ok: boolean, reason?: string, ref?: string } = { ok: false, changed: 0, reason: '未启用' }
        if (gitCommit) gitInfo = await gitSnapshot(runId)
        // [multi-workspace-v1] SCRIPTS_DIR 是活跃工作区的模块级绑定，ALS 修不到它——
        //   此处必须从作用域 root 现算，否则脚本文件会写进错误工作区
        const scriptPath = path.join(getRoot(), '.ai-runner/scripts', `${runId}.cjs`)
        try {
          fs.writeFileSync(scriptPath, effectiveScript)
          const beforeSnap = snapshot()
          const before = beforeSnap.contents
          const beforeMeta = beforeSnap.meta
          // [cumulative-baseline-v1] 运行**前**索引：累积视图的基准必须落在「本轮开始前」。
          //   必须在 runScript 之前取——脚本一跑完磁盘状态就变了，after 再扫就取不到基准态。
          //   与 beforeMeta 的差别：beforeMeta 来自 snapshot() 的 FileMeta，这里是 scanIndex 的
          //   FileIndex（同字段不同遍历），下游 /diff-from-baseline 用的是 FileIndex 口径，不能混用。
          const beforeIndex = scanIndex()
          // [pipeline-flow-v1] run.ts 仅能观测 EXECUTE 段；其余段由客户端/headless 侧完成，
          // 服务端无法插桩。补标前置段为 ok，让前端 5 段聚合有完整数据（否则恒 pending）
          for (const seg of ['ASK_LOCAL', 'ASK_RELAY', 'ASK_INJECT', 'AI_GENERATE', 'AI_COMPLETE', 'EXTRACT', 'SCRIPT_VALIDATE'] as const) {
            markOk(pipeline, seg)
          }
          markRunning(pipeline, 'EXECUTE')
          // [script-timeout-relax-v1] 全量测试/构建耗时 >60s（selfcheck-l2 约 80s），
          //   原 60s 硬编码会 SIGTERM 腰斩长任务 → 假「超时失败」。放宽到 180s 留余量。
          const result = await runScript(scriptPath, SCRIPT_TIMEOUT_MS, ac.signal, overlayPath, toolLogPath, (s: string, data: string) => {
            writeFrame({ type: 'chunk', stream: s, data })
          }, sandbox, sessionId)
          const scriptOk = result.code === 0
          if (scriptOk) markOk(pipeline, 'EXECUTE'); else markFailed(pipeline, 'EXECUTE', `exit ${result.code}`)
          // [reject-breaker-v1] 成功执行清 streak：偶发失败不误伤，只有连续拒收才熔断
          if (scriptOk) resetRejectStreak(sessionId)
          // [pipeline-flow-v1] 补标 COLLECT（tools 读取成功即视为完成）与 RESULT_RELAY / RESULT_INJECT
          // （由客户端消费 summary 帧，服务端不插桩）
          markOk(pipeline, 'COLLECT')
          markOk(pipeline, 'RESULT_RELAY')
          markOk(pipeline, 'RESULT_INJECT')
          try {
            const perfPath = path.join(getRoot(), '.ai-runner/perf.json')
            const raw = fs.existsSync(perfPath) ? fs.readFileSync(perfPath, 'utf8') : ''
            const store = deserialize(raw)
            const dur = Date.now() - startedAt
            const slow = checkSlow(store, 'EXECUTE', dur)
            recordSample(store, 'EXECUTE', dur)
            fs.writeFileSync(perfPath, serialize(store))
            if (slow.slow) writeChannelLog('runner', { runId, perfSlow: true, ratio: slow.ratio, baselineMs: slow.baselineMs })
          } catch { /* ignore */ }
          const tools = await readToolLogWithRetry(toolLogPath)
          // [selfcheck-evidence-v1] 保留 toolLog 作为自检命令对账证据（期一 L0-commands 数据源）；
          // 清理策略归期二（按 mtime 过期清理），tmp 目录累积量可忽略
          let dryRunFailed = false
          let dryRunChangeCount = 0
          let dryRunReason: string | undefined
          let wantChanges: Change[] | undefined
          let applyError: string | undefined
          if (scriptOk) {
            const r = applyOverlay(overlayPath)
            if (r.failed) applyError = r.failed
          } else {
            const claimed = readOverlayChanges(overlayPath, before)
            if (claimed.length > 0) {
              dryRunFailed = true
              dryRunChangeCount = claimed.length
              dryRunReason = result.stderr.slice(-500) || (`退出码 ${result.code}`)
              wantChanges = claimed
            }
          }
          try { fs.unlinkSync(overlayPath) } catch { /* ignore */ }
          // [run-dedup-calls-v1] 同一次运行内 scanMeta 与 beforeMeta 均不变，一次 diffMeta 即可
          const changes = diffMeta(before, beforeMeta, scanMeta())
          const lintTargets = pickLintTargets(changes)
          if (process.env.AI_RUNNER_LINT_DEBUG) {
            console.error(`[ai-runner][lint-debug] changes=${changes.length} targets=${lintTargets.length} hasEslint=${hasEslint()}`)
          }
          let lint: LintResult | null = null
          if (lintTargets.length && hasEslint()) {
            const r = await runEslint(lintTargets)
            lint = { ran: true, files: lintTargets.length, ok: r.code === 0, stdout: r.stdout, stderr: r.stderr }
          }
          // [git-first-rollback-v1] 有运行前 ref 就不落 .before：内容已在 git 对象里，rollback 走
          // gitRestoreFile；ref 缺失（非 git / 快照失败）才退回内容副本，两路都能还原。
          saveSnapshot(runId, before, changes, gitInfo.ref ? { gitRef: gitInfo.ref } : undefined)
          try { saveIndex(runId, scanIndex(), runDir(runId)) } catch { /* ignore */ }
          // [cumulative-baseline-v1] 与运行后索引同目录落一份运行前索引，供 /diff-from-baseline
          //   的 mode='before' 计算「自本轮开始前以来」的累积改动。失败不阻断本轮（累积视图降级）。
          try { saveIndexBefore(beforeIndex, runDir(runId)) } catch { /* ignore */ }
          gcSnapshots(20)
          const testFiles = changes.filter(ch => ch.type !== 'deleted' && /\.(?:test|spec)\.(?:ts|js|mjs|cjs)$/.test(ch.path)).map(ch => ch.path)
          const [tsc, test] = await Promise.all([runTsc(pickTscTargets(changes), runId), runTests(testFiles)])
          try { fs.unlinkSync(scriptPath) } catch { /* ignore */ }
          const scriptMeta = parseScriptMeta(effectiveScript)
          const scriptDesc = scriptMeta.desc
          const scriptWhy = scriptMeta.why
          const claimed = parseClaimed(effectiveScript)
          const compliance = computeCompliance(effectiveScript, scriptMeta.desc)
          const claimMismatch: ClaimMismatch | null = computeClaimMismatch(claimed, changes)
          // [delivery-routing-v1] 死信槽写入识别（消费 claimMismatch.extra：写了但没声明）
          const deadLetterWrites = pickDeadLetterWrites(claimMismatch?.extra ?? [])
          const errorFiles = extractErrorFiles(`${result.stderr}\n${result.stdout}`)
          const fingerprints = fingerprintErrors(`${result.stderr}\n${result.stdout}`)
          let gitAfter: { ok: boolean, commit?: string, reason?: string } | null = null
          if (gitCommit && gitInfo.ok && changes.length > 0) {
            const lc = body?.loopCtx
            const loopCtxNormalized = lc && lc.loopId ? { loopId: String(lc.loopId), round: Number(lc.round) || 1, max: Number(lc.max) || 8 } : undefined
            gitAfter = await gitCommitAfter(runId, changes, result.code, Date.now() - startedAt, gitVerify, scriptDesc, loopCtxNormalized)
          }
          let smoke: SmokeResult | null = null
          if (body?.smoke === true && scriptOk && changes.length > 0) {
            // [discover-targets-v1] 不再只验宿主自身：自动发现业务 app（端口探测 + 配置标注 + env 覆盖）
            const targets = await discoverTargets({ hostUrl: `${proto}://${host}` })
            smoke = await runSmokeTargets(targets)
          }
          try {
            const stPath = path.join(getRoot(), '.ai-runner/state.json')
            const stObj = fs.existsSync(stPath) ? JSON.parse(fs.readFileSync(stPath, 'utf8')) : {}
            const sid = String(stObj.sessionId || 'unknown')
            // [rules-version-live-v1] rv 已在函数开头算一次（SYSTEM.md 在同一次运行内不变）
            const roundN = Number(body?.loopCtx?.round) || Number(stObj.round) || 0
            writeRoundSnapshot(getRoot(), {
              round: roundN,
              runId,
              sessionId: sid,
              ts: startedAt,
              todo: Array.isArray(stObj.todo) ? stObj.todo : [],
              // [fail-body-preserve-v1] 失败轮 head 放宽到 2000 字符：round-N.json 是失败分析的唯一数据源；
              // 原 500 字符截断导致重放/全扫描不可能，DSPy 训练样本不完整（流程方向缺陷）
              script: {
                head: effectiveScript.slice(0, result.code === 0 ? 500 : 2000),
                hash: hashScript(effectiveScript),
                size: effectiveScript.length,
              },
              pipeline,
              changes,
              decisions: Array.isArray(stObj.decisions) ? stObj.decisions.slice(-10) : [],
              exitCode: result.code,
              // [run-timeout-visible-v1] 「超时」必须与「真失败」可区分，否则 AI 会把
              //   已部分成功（如文件已写完但进程被杀）当失败重试，白烧轮次
              timedOut: result.timedOut === true,
              durationMs: Date.now() - startedAt,
              rulesVersion: rv,
              // [tier2a-3b] 失败诊断字段（成功轮不落，避免噪音）
              stderr: result.code !== 0 ? String(result.stderr || '').slice(0, 500) : undefined,
              errorFiles: result.code !== 0 && errorFiles.length > 0 ? errorFiles : undefined,
            })
            // [state-read-dedup-v1] 复用上方已解析的 stObj，避免同一 try 块两次读盘（性能）
            const cur: Record<string, unknown> = { ...stObj }
            cur.pipeline = pipeline
            // [rules-version-write-v1] run.ts 直写 state.json 是主路径，必须同步 rulesVersion；
            // 否则依赖 __AI__.updateState 的 _ensureEnvFields 永不触发，下游按 rulesHash 分组失效
            cur.rulesVersion = rv
            cur.updatedAt = new Date().toISOString()
            fs.writeFileSync(stPath, JSON.stringify(cur, null, 2))
          } catch { /* ignore */ }
          writeChannelLog('runner', { runId, exit: result.code, timedOut: result.timedOut === true, durationMs: Date.now() - startedAt, changeCount: changes.length, pipeline, ctx: scriptMeta.ctx || 'default' })
          writeRunLog({ ts: startedAt, runId, desc: scriptDesc, why: scriptWhy, script: effectiveScript.slice(0, 2000), exit: result.code, timedOut: result.timedOut === true, durationMs: Date.now() - startedAt, changeCount: changes.length, changes: changes.slice(0, 50), errorFiles, fingerprints })
          const { needFiles, decision } = parseDecisionMarkers(result.stdout)
          if (decision || (needFiles && needFiles.length)) {
            writeChannelLog('decisions', { runId, round: Number(body?.loopCtx?.round) || 0, decision: decision || null, needFiles: needFiles || [], exit: result.code })
          }
          try {
            const cpFile = path.join(getRoot(), '.ai-runner/compliance.jsonl')
            const cpRec = { ...compliance, rulesHash: rv, runId, ts: Date.now() } // [drop-codeBlocks-v1]
            // [log-rotate-v1] 走统一轮转：compliance.jsonl 实测 3MB 且持续增长
            appendJsonlCapped(cpFile, JSON.stringify(cpRec))
          } catch { /* ignore */ }
          writeFrame({
            type: 'summary',
            runId,
            rulesHash: rv,
            compliance,
            scriptDesc,
            scriptWhy,
            code: result.code,
            // [run-timeout-visible-v1] 与 round 快照同口径：让 AI 在 summary 帧就能看到
            //   「这是超时」而不是「这是失败」，避免对超时做无意义的重试
            timedOut: result.timedOut === true,
            ok: scriptOk,
            decision,
            needFiles,
            scriptMode: scriptMeta.mode,
            scriptCtx: scriptMeta.ctx,
            // [budget-feedback-v1] **每一轮**都下发脚本体积，不只在被截断时。
            // [WHY] AI 无法自行测量自己的输出长度（它看不到 token 计数），若只在 400 时才告知，
            //   它就永远在「已经撞墙」之后才知道墙在哪——只能事后补救，无法事前收窄。
            //   把每轮实测体积带回决策回路，AI 才能主动决定「这轮还能加多少」。
            // [CONSTRAINT] 与上方 400 分支共用 effectiveScript 口径（都不含脚本头），两处数字必须可比。
            scriptSize: measureScriptSize(effectiveScript),
            stdoutTail: scriptMeta.ctx === 'full' ? result.stdout : (result.stdout.length > 2000 ? result.stdout.slice(-2000) : result.stdout),
            stderrTail: scriptMeta.ctx === 'full' ? result.stderr : (result.stderr.length > 4000 ? result.stderr.slice(-4000) : result.stderr),
            notice: [
              applyError ? `[overlay apply error] ${applyError}` : '',
              deadLetterWrites.length ? `[delivery-routing-v1] 检测到写进 .ai-runner/（git 忽略区）的交付物：${deadLetterWrites.join(', ')}；如为最终交付，请改用 DONE 正文。` : '',
            ].filter(Boolean).join(' ') || undefined,
            changes,
            lint,
            test,
            tsc,
            errorFiles,
            // [p3-4-fingerprint-visible-v1] fingerprintErrors 已在 :201 用 TS AST 算出
            //   「文件 + 行号 + 所属符号」，此前只落运行日志（:254）——
            //   errorFiles 到此只有路径（行号在 extractErrorFiles 的正则里被丢弃），
            //   AI 只能自己从 stderr 里重新解析位置。此处补进 summary 帧，
            //   让前端能把 AST 级定位直接注入回填 prompt。
            fingerprints,
            git: { ...gitInfo, after: gitAfter },
            dryRunFailed,
            dryRunChangeCount,
            dryRunReason,
            wantChanges,
            tools,
            smoke,
            claimMismatch,
            // [pipeline-in-summary-v1] 让客户端在运行结束时立即拿到最新 pipeline，
            // 免去等待 PipelineStrip 的 1.5s 轮询周期
            pipeline,
            // [multi-workspace-v1] 本次运行的目标工作区，客户端可据此分视图
            workspaceId: wsId || undefined,
          })
        } finally {
          try { fs.unlinkSync(overlayPath) } catch { /* ignore */ }
          // [selfcheck-evidence-v1] toolLog 不在此删除：作为自检证据保留（见上方说明）
          try { fs.unlinkSync(scriptPath) } catch { /* ignore */ }
        }
        controller.close()
      },
    })

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      },
    })
  })
})
