// /run —— node 沙盒 / shell 脚本执行主入口
import type { SmokeResult } from '../headless/smoke.js'
import type { ClaimMismatch, LintResult } from '../post-run/types.js'
import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { getRoot, SCRIPTS_DIR } from '../config.js'
import type { Change } from '../config.js'
import { diffMeta, ensureDirs, gcSnapshots, runDir, saveSnapshot, scanMeta, snapshot, writeRunLog } from '../state/snapshot.js'
import { runSmoke } from '../headless/smoke.js'
import { gitCommitAfter, gitSnapshot } from '../git.js'
import { runProcess } from '../process/proc.js'
import { BASH_TIMEOUT_MS, buildEnvWhitelist, checkBashBlacklist } from '../process/bash-guard.js'
import { saveIndex, scanIndex } from '../utils/index-index.js'
import { parseJSON, readBody, sendJSON } from '../server/http.js'
import { runScript } from '../post-run/run-script.js'
import { readToolLogWithRetry } from '../post-run/tool-log.js'
import { applyOverlay, readOverlayChanges } from '../post-run/overlay.js'
import { hasEslint, pickLintTargets, runEslint } from '../post-run/lint.js'
import { pickTscTargets, runTsc } from '../post-run/tsc.js'
import { runTests } from '../post-run/test.js'
import { extractErrorFiles } from '../post-run/error-files.js'
import { fingerprintErrors } from '../utils/error-fingerprint.js'
import { parseClaimed, parseScriptMeta } from '../post-run/script-meta.js'
import { splitShebang } from '../post-run/shebang.js'
import { checkScriptSyntax } from '../post-run/script-check.js'
import { parseDecisionMarkers } from '../post-run/decision.js'
import { hashRules } from '../post-run/compliance.js'
import { computeClaimMismatch, computeCompliance } from './run-helpers.js'

/** POST /run → node 沙盒 / shell 脚本执行（NDJSON 流） */
export async function handleRunRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (req.method !== 'POST' || url.pathname !== '/run') return false
  ensureDirs()
  fs.mkdirSync(path.join(getRoot(), '.ai-runner/tmp'), { recursive: true })
  const startedAt = Date.now()
  const body = parseJSON<{ script?: string, gitCommit?: boolean, gitVerify?: boolean, sandbox?: string, loopCtx?: { loopId?: string, round?: number, max?: number }, smoke?: boolean }>(await readBody(req))
  const sandboxRaw = String(body?.sandbox || 'read-only')
  let sandbox = ['read-only', 'workspace-write', 'full'].includes(sandboxRaw) ? sandboxRaw : 'read-only'
  const script = String(body?.script || '').trim()
  // [P3-2d] @mode: diff 强制只读沙盒（parseScriptMeta 函数声明会提升，可安全前置调用）
  try {
    if (parseScriptMeta(script).mode === 'diff') {
      sandbox = 'read-only'
    }
  } catch { /* ignore */ }
  const gitCommit = Boolean(body?.gitCommit)
  const gitVerify = Boolean(body?.gitVerify)
  if (!script) { sendJSON(res, { error: '脚本为空' }, 400); return true }
  // === shebang 分流：非 node shebang 走 shell ===
  // shebang 分流（已抽至 post-run/shebang.ts）
  const { isNodeScript, effectiveScript } = splitShebang(script)
  if (isNodeScript) {
    const syntax = checkScriptSyntax(effectiveScript)
    if (!syntax.ok) {
      sendJSON(res, { error: `脚本语法错误：${syntax.error}`, syntaxError: true }, 400)
      return true
    }
  }
  if (!isNodeScript) {
    const shellHit = checkBashBlacklist(script)
    if (shellHit) {
      sendJSON(res, { error: `shell 脚本命中黑名单：${shellHit}`, blacklistHit: shellHit }, 400); return true
    }
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    })
    const writeS = (obj: unknown) => { try { res.write(`${JSON.stringify(obj)}\n`) } catch { } }
    const ac = new AbortController()
    req.on('aborted', () => ac.abort())
    const r = await runProcess(script, {
      cwd: getRoot(),
      env: buildEnvWhitelist(getRoot()),
      shell: true,
      timeoutMs: BASH_TIMEOUT_MS,
      timeoutLabel: 'shell 脚本超时',
      signal: ac.signal,
      onChunk: (stream, data) => writeS({ type: 'chunk', stream, data }),
    })
    writeS({
      type: 'summary',
      runId: '',
      code: r.code,
      ok: r.code === 0,
      stdoutTail: r.stdout.slice(-2000),
      stderrTail: r.stderr.slice(-4000),
      changes: [],
      shell: true,
    })
    res.end()
    return true
  }
  // === 以下原有 node 沙盒逻辑 ===

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const overlayPath = path.join(getRoot(), '.ai-runner/tmp', `${runId}-overlay.json`)
  const toolLogPath = path.join(getRoot(), '.ai-runner/tmp', `${runId}-tools.jsonl`)
  try { fs.unlinkSync(overlayPath) } catch { }
  try { fs.unlinkSync(toolLogPath) } catch { }
  let gitInfo: { commit?: string, changed: number, ok: boolean, reason?: string } = { ok: false, changed: 0, reason: '未启用' }
  if (gitCommit) {
    gitInfo = await gitSnapshot(runId)
  }
  const scriptPath = path.join(SCRIPTS_DIR, `${runId}.cjs`)
  try {
    fs.writeFileSync(scriptPath, effectiveScript)

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    })
    const writeFrame = (obj: unknown) => {
      try { res.write(`${JSON.stringify(obj)}\n`) } catch { }
    }
    const beforeSnap = snapshot()
    const before = beforeSnap.contents
    const beforeMeta = beforeSnap.meta
    const ac = new AbortController()
    req.on('aborted', () => ac.abort())
    const result = await runScript(scriptPath, 60_000, ac.signal, overlayPath, toolLogPath, (stream, data) => {
      writeFrame({ type: 'chunk', stream, data })
    }, sandbox)
    const scriptOk = result.code === 0
    const tools = await readToolLogWithRetry(toolLogPath)
    try { fs.unlinkSync(toolLogPath) } catch { }
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
    try { fs.unlinkSync(overlayPath) } catch { }

    // 脚本自身改动（增量元数据扫描，只读取疑似变更文件的内容）
    const scriptChanges = diffMeta(before, beforeMeta, scanMeta())

    // 对改动源文件跑 eslint --fix
    // 首次扫描疑似 overlay 落盘竞态漏检，兜底重扫一次
    const lintTargets = pickLintTargets(scriptChanges)
    if (process.env.AI_RUNNER_LINT_DEBUG) {
      console.error(`[ai-runner][lint-debug] scriptChanges=${scriptChanges.length} targets=${lintTargets.length} hasEslint=${hasEslint()}`)
    }
    let lint: LintResult | null = null
    if (lintTargets.length && hasEslint()) {
      const r = await runEslint(lintTargets)
      lint = {
        ran: true,
        files: lintTargets.length,
        ok: r.code === 0,
        stdout: r.stdout,
        stderr: r.stderr,
      }
    }

    // eslint 后可能又改了文件 —— 用最终元数据重新算净变化
    const changes = diffMeta(before, beforeMeta, scanMeta())

    saveSnapshot(runId, before, changes)
    try { saveIndex(runId, scanIndex(), runDir(runId)) } catch { }
    gcSnapshots(20)
    // [AI-Runner] TDD：自动运行新增/修改的测试文件
    const testFiles = changes
      .filter(c => c.type !== 'deleted' && /\.(?:test|spec)\.(?:ts|js|mjs|cjs)$/.test(c.path))
      .map(c => c.path)
    const [tsc, test] = await Promise.all([
      runTsc(pickTscTargets(changes), runId),
      runTests(testFiles),
    ])
    try { fs.unlinkSync(scriptPath) } catch { /* ignore */ }

    // 失败时从错误输出里提取项目内文件，供前端补全源码
    const scriptMeta = parseScriptMeta(effectiveScript)
    const scriptDesc = scriptMeta.desc
    const scriptWhy = scriptMeta.why
    const claimed = parseClaimed(effectiveScript)

    // [A7] 规则遵守度静态特征（已抽至 run-helpers.ts）
    const compliance = computeCompliance(effectiveScript, scriptMeta.desc)
    const claimMismatch: ClaimMismatch | null = computeClaimMismatch(claimed, changes)
    const errorFiles = extractErrorFiles(`${result.stderr}\n${result.stdout}`)
    const fingerprints = fingerprintErrors(`${result.stderr}\n${result.stdout}`)

    // after commit：按本次 changes 提交
    let gitAfter: { ok: boolean, commit?: string, reason?: string } | null = null
    if (gitCommit && gitInfo.ok && changes.length > 0) {
      const lc = body?.loopCtx
      const loopCtxNormalized = lc && lc.loopId ? { loopId: String(lc.loopId), round: Number(lc.round) || 1, max: Number(lc.max) || 8 } : undefined
      gitAfter = await gitCommitAfter(runId, changes, result.code, Date.now() - startedAt, gitVerify, scriptDesc, loopCtxNormalized)
    }

    let smoke: SmokeResult | null = null
    const smokeEnabled = body?.smoke === true
    if (smokeEnabled && scriptOk && changes.length > 0) {
      const proto = (req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http'
      const host = req.headers.host || 'localhost:5173'
      smoke = await runSmoke(`${proto}://${host}`)
    }
    writeRunLog({
      ts: startedAt,
      runId,
      desc: scriptDesc,
      why: scriptWhy,
      script: effectiveScript.slice(0, 2000),
      exit: result.code,
      durationMs: Date.now() - startedAt,
      changeCount: changes.length,
      changes: changes.slice(0, 50),
      errorFiles,
      fingerprints,
    })

    // [P3-2a] 解析协议标记（已抽至 post-run/decision.ts）
    const { needFiles, decision } = parseDecisionMarkers(result.stdout)
    // [A8] 追加 compliance 记录（报告数据源）
    try {
      const cpFile = path.join(getRoot(), '.ai-runner/compliance.jsonl')
      const cpRec = {
        ...compliance,
        rulesHash: hashRules(),
        codeBlocks: 0,
        runId,
        ts: Date.now(),
      }
      const cpLine = JSON.stringify(cpRec)
      const nl = String.fromCharCode(10)
      fs.appendFileSync(cpFile, cpLine + nl)
    } catch { }
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
      // stdout/stderr 全程已通过 chunk 帧流式发出，summary 只带尾部片段（刷新/丢帧兜底），不再全量重复
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
    res.end()
  } finally {
    try { fs.unlinkSync(overlayPath) } catch { }
    try { fs.unlinkSync(toolLogPath) } catch { }
    try { fs.unlinkSync(scriptPath) } catch { }
  }
  return true
  return true
}
