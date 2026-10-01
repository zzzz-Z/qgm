// [arch-hono/run-v1] POST /run —— node 沙盒 / shell 脚本执行（NDJSON 流式；Hono 版）
// [g2-deadcode-cleanup-v1] G2 收窄后仅保留 node 脚本路径：bash 分支与 shell:true 的 runProcess 分支已删除
import { Hono } from 'hono'
import {
  applyOverlay,
  checkScriptSyntax,
  computeClaimMismatch,
  computeCompliance,
  diffMeta,
  ensureDirs,
  extractErrorFiles,
  fingerprintErrors,
  gcSnapshots,
  getRoot,
  gitCommitAfter,
  gitSnapshot,
  hasEslint,
  hashRules,
  parseClaimed,
  parseDecisionMarkers,
  parseScriptMeta,
  pickLintTargets,
  pickTscTargets,
  readOverlayChanges,
  readToolLogWithRetry,
  runDir,
  runEslint,
  runScript,
  runSmoke,
  runTests,
  runTsc,
  saveIndex,
  saveSnapshot,
  scanIndex,
  scanMeta,
  scanScriptHead,
  SCRIPTS_DIR,
  snapshot,
  splitShebang,
  writeRunLog,
} from '../deps.js'
import type { Change, ClaimMismatch, LintResult, SmokeResult } from '../deps.js'
import { createPipeline, markFailed, markOk, markRunning } from '../state/pipeline.js'
import { writeRoundSnapshot } from '../state/timeline.js'
import { writeChannelLog } from '../state/snapshot.js'
import { checkSlow, deserialize, recordSample, serialize } from '../state/perf.js'
import fs from 'node:fs'
import path from 'node:path'

interface RunBody {
  script?: string
  gitCommit?: boolean
  gitVerify?: boolean
  sandbox?: string
  loopCtx?: { loopId?: string, round?: number, max?: number }
  smoke?: boolean
}

/** run 路由的 Hono 实例 */
export const runHono = new Hono()

runHono.post('/run', async (c) => {
  ensureDirs()
  fs.mkdirSync(path.join(getRoot(), '.ai-runner/tmp'), { recursive: true })
  const startedAt = Date.now()
  const pipeline = createPipeline()
  const body = (await c.req.json().catch(() => null)) as RunBody | null
  const sandboxRaw = String(body?.sandbox || 'read-only')
  let sandbox = ['read-only', 'workspace-write', 'full'].includes(sandboxRaw) ? sandboxRaw : 'read-only'
  const script = String(body?.script || '').trim()
  try {
    if (parseScriptMeta(script).mode === 'diff') sandbox = 'read-only'
  } catch { /* ignore */ }
  const gitCommit = Boolean(body?.gitCommit)
  const gitVerify = Boolean(body?.gitVerify)
  if (!script) return c.json({ error: '脚本为空' }, 400)

  // [g2-narrow-v1] 脚本头契约前置拦截（先于 splitShebang 与语法检查）
  const head = scanScriptHead(script)
  if (!head.ok) {
    return c.json({
      error: `脚本头契约违规：${head.reason}`,
      metaError: true,
      rule: 'SYSTEM.md',
    }, 400)
  }
  const { isNodeScript, effectiveScript } = splitShebang(script)
  if (isNodeScript) {
    const syntax = checkScriptSyntax(effectiveScript)
    if (!syntax.ok) return c.json({ error: `脚本语法错误：${syntax.error}`, syntaxError: true }, 400)
  }

  const enc = new TextEncoder()
  const ac = new AbortController()
  try { c.req.raw.signal.addEventListener('abort', () => ac.abort()) } catch { /* ignore */ }
  const url = new URL(c.req.url)
  const proto = url.protocol === 'https:' ? 'https' : 'http'
  const host = c.req.header('host') || 'localhost:5173'

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const writeFrame = (frame: unknown) => {
        try { controller.enqueue(enc.encode(`${JSON.stringify(frame)}\n`)) } catch { /* ignore */ }
      }

      const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      const overlayPath = path.join(getRoot(), '.ai-runner/tmp', `${runId}-overlay.json`)
      const toolLogPath = path.join(getRoot(), '.ai-runner/tmp', `${runId}-tools.jsonl`)
      try { fs.unlinkSync(overlayPath) } catch { /* ignore */ }
      try { fs.unlinkSync(toolLogPath) } catch { /* ignore */ }
      let gitInfo: { commit?: string, changed: number, ok: boolean, reason?: string } = { ok: false, changed: 0, reason: '未启用' }
      if (gitCommit) gitInfo = await gitSnapshot(runId)
      const scriptPath = path.join(SCRIPTS_DIR, `${runId}.cjs`)
      try {
        fs.writeFileSync(scriptPath, effectiveScript)
        const beforeSnap = snapshot()
        const before = beforeSnap.contents
        const beforeMeta = beforeSnap.meta
        markRunning(pipeline, 'EXECUTE')
        const result = await runScript(scriptPath, 60000, ac.signal, overlayPath, toolLogPath, (s: string, data: string) => {
          writeFrame({ type: 'chunk', stream: s, data })
        }, sandbox)
        const scriptOk = result.code === 0
        if (scriptOk) markOk(pipeline, 'EXECUTE'); else markFailed(pipeline, 'EXECUTE', `exit ${result.code}`)
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
        try { fs.unlinkSync(toolLogPath) } catch { /* ignore */ }
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
        const scriptChanges = diffMeta(before, beforeMeta, scanMeta())
        const lintTargets = pickLintTargets(scriptChanges)
        if (process.env.AI_RUNNER_LINT_DEBUG) {
          console.error(`[ai-runner][lint-debug] scriptChanges=${scriptChanges.length} targets=${lintTargets.length} hasEslint=${hasEslint()}`)
        }
        let lint: LintResult | null = null
        if (lintTargets.length && hasEslint()) {
          const r = await runEslint(lintTargets)
          lint = { ran: true, files: lintTargets.length, ok: r.code === 0, stdout: r.stdout, stderr: r.stderr }
        }
        const changes = diffMeta(before, beforeMeta, scanMeta())
        saveSnapshot(runId, before, changes)
        try { saveIndex(runId, scanIndex(), runDir(runId)) } catch { /* ignore */ }
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
          smoke = await runSmoke(`${proto}://${host}`)
        }
        try {
          const stPath = path.join(getRoot(), '.ai-runner/state.json')
          const stObj = fs.existsSync(stPath) ? JSON.parse(fs.readFileSync(stPath, 'utf8')) : {}
          const sid = String(stObj.sessionId || 'unknown')
          const rv = String(stObj.rulesVersion || 'unknown')
          const roundN = Number(body?.loopCtx?.round) || Number(stObj.round) || 0
          writeRoundSnapshot(getRoot(), {
            round: roundN,
            runId,
            sessionId: sid,
            ts: startedAt,
            todo: Array.isArray(stObj.todo) ? stObj.todo : [],
            script: { head: effectiveScript.slice(0, 500), hash: '', size: effectiveScript.length },
            pipeline,
            changes,
            decisions: Array.isArray(stObj.decisions) ? stObj.decisions.slice(-10) : [],
            exitCode: result.code,
            durationMs: Date.now() - startedAt,
            rulesVersion: rv,
            // [tier2a-3b] 失败诊断字段（成功轮不落，避免噪音）
            stderr: result.code !== 0 ? String(result.stderr || '').slice(0, 500) : undefined,
            errorFiles: result.code !== 0 && errorFiles.length > 0 ? errorFiles : undefined,
          })
          const cur = JSON.parse(fs.readFileSync(stPath, 'utf8'))
          cur.pipeline = pipeline
          cur.updatedAt = new Date().toISOString()
          fs.writeFileSync(stPath, JSON.stringify(cur, null, 2))
        } catch { /* ignore */ }
        writeChannelLog('runner', { runId, exit: result.code, durationMs: Date.now() - startedAt, changeCount: changes.length, pipeline })
        writeRunLog({ ts: startedAt, runId, desc: scriptDesc, why: scriptWhy, script: effectiveScript.slice(0, 2000), exit: result.code, durationMs: Date.now() - startedAt, changeCount: changes.length, changes: changes.slice(0, 50), errorFiles, fingerprints })
        const { needFiles, decision } = parseDecisionMarkers(result.stdout)
        if (decision || (needFiles && needFiles.length)) {
          writeChannelLog('decisions', { runId, round: Number(body?.loopCtx?.round) || 0, decision: decision || null, needFiles: needFiles || [], exit: result.code })
        }
        try {
          const cpFile = path.join(getRoot(), '.ai-runner/compliance.jsonl')
          const cpRec = { ...compliance, rulesHash: hashRules(), runId, ts: Date.now() } // [drop-codeBlocks-v1]
          const nl = String.fromCharCode(10)
          fs.appendFileSync(cpFile, JSON.stringify(cpRec) + nl)
        } catch { /* ignore */ }
        writeFrame({
          type: 'summary',
          runId,
          rulesHash: hashRules(),
          compliance,
          scriptDesc,
          scriptWhy,
          code: result.code,
          ok: scriptOk,
          decision,
          needFiles,
          scriptMode: scriptMeta.mode,
          scriptCtx: scriptMeta.ctx,
          stdoutTail: scriptMeta.ctx === 'full' ? result.stdout : (result.stdout.length > 2000 ? result.stdout.slice(-2000) : result.stdout),
          stderrTail: scriptMeta.ctx === 'full' ? result.stderr : (result.stderr.length > 4000 ? result.stderr.slice(-4000) : result.stderr),
          notice: applyError ? `[overlay apply error] ${applyError}` : undefined,
          changes,
          lint,
          test,
          tsc,
          errorFiles,
          git: { ...gitInfo, after: gitAfter },
          dryRunFailed,
          dryRunChangeCount,
          dryRunReason,
          wantChanges,
          tools,
          smoke,
          claimMismatch,
        })
      } finally {
        try { fs.unlinkSync(overlayPath) } catch { /* ignore */ }
        try { fs.unlinkSync(toolLogPath) } catch { /* ignore */ }
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
