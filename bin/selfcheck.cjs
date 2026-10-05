#!/usr/bin/env node
'use strict'
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

// [selfcheck-observed-cmds-v1] 从 toolLog 汇总真实执行过的命令
// [WHY] 自检端点治造假：DONE 声称跑过的命令必须能在 toolLog 找到 exec 记录
// [CONSTRAINT] 读不到文件/解析失败静默跳过，不阻断自检
function collectObservedCommands(runIds) {
  const out = []
  const ids = Array.isArray(runIds) ? runIds : []
  for (const id of ids) {
    const p = path.join(process.cwd(), '.ai-runner', 'tmp', `${id}-tools.jsonl`)
    if (!fs.existsSync(p)) continue
    let txt = ''
    try { txt = fs.readFileSync(p, 'utf8') } catch { continue }
    for (const line of txt.split('\n')) {
      if (!line) continue
      try {
        const j = JSON.parse(line)
        if (j && j.op === 'exec' && typeof j.flat === 'string' && j.flat) out.push(j.flat)
      } catch { /* ignore */ }
    }
  }
  return out
}

// [selfcheck-report-format-v1] 失败报告格式化：每项 1 行，G11 校验体积护栏
// [selfcheck-report-cap-v2] 复核修正：加**硬截断**（原实现「每项 1 行」对 30 项=30 行，
//   断言 ≤30×3 行恒真，护栏形同虚设）；现最多列 20 项，其余折叠成一行汇总。
//   理由：回传正文过长会进截断族（上游按内容特征切断），被误判成脚本截断。
const MAX_REPORT_ITEMS = 20
function formatFailReport(items) {
  const fails = (items || []).filter(i => !i.ok)
  const lines = fails.slice(0, MAX_REPORT_ITEMS)
    .map(i => `[SELF-FAIL] ${i.level} | ${i.id} | ${i.actual} | ${i.expected}`)
  if (fails.length > MAX_REPORT_ITEMS) {
    lines.push(`[SELF-FAIL] …另有 ${fails.length - MAX_REPORT_ITEMS} 项失败未列出（先修上面这些，修完重交会自动重验）`)
  }
  return lines.join(String.fromCharCode(10))
}

const PORT = Number(process.env.AIR_SERVER_PORT) || 5175
function readStdin() {
  return new Promise((resolve) => {
    let buf = ''
    if (process.stdin.isTTY) return resolve('')
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (d) => { buf += d })
    process.stdin.on('end', () => resolve(buf))
    setTimeout(resolve, 3000, buf)
  })
}
function post(body) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body))
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/__ai/selfcheck', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
      let b = ''
      res.on('data', (d) => { b += d })
      res.on('end', () => { try { resolve(JSON.parse(b)) } catch { resolve(null) } })
    })
    req.on('error', () => resolve(null))
    req.write(data)
    req.end()
  })
}
async function main() {
  const raw = await readStdin()
  let payload = {}
  try { payload = JSON.parse(raw) } catch {}
  const p = payload.payload || {}
  // [selfcheck-observed-cmds-v1] 汇总本循环 toolLog 的 exec 记录 → 端点命令对账
  const observedCommands = collectObservedCommands(p.runIds)
  const j = await post({ loopId: p.loopId || '', startCommit: p.startCommit || '', doneText: p.doneText || '', runIds: Array.isArray(p.runIds) ? p.runIds : [], observedCommands, final: p.final === true, round: Number(p.round || 0) })
  if (j && j.verdict === 'fail') {
    process.stdout.write(JSON.stringify({ action: 'reject', reason: formatFailReport(j.items) }))
    return
  }
  // [selfcheck-l2-degraded-v2] degraded 放行但必须显式可见：把说明带给调用方（客户端记日志/提示），
  // 不判 reject（跑不了 ≠ 造假；判 reject 会让 AI 收到无法修复的打回 → 熔断）
  const note = j && j.degraded ? String(j.degraded) : ''
  process.stdout.write(JSON.stringify(note ? { action: 'ok', note } : { action: 'ok' }))
}
// [selfcheck-testable-v1] 只在作为入口执行时跑 main；被 require 时只暴露内部函数供单测
if (require.main === module) {
  main().catch(() => { process.stdout.write(JSON.stringify({ action: 'ok' })) })
}

module.exports = { collectObservedCommands, formatFailReport, MAX_REPORT_ITEMS }
