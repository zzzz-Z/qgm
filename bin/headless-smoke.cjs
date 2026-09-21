#!/usr/bin/env node
/* eslint-disable no-console -- CLI 输出 */
// @desc: 无头链路 smoke：连接 /__ai/ws，跑 open → fill(空) → state 序列，验证服务端消息分发
// @why: headless 链路从未端到端验证；本工具用最小脚本验证 WS 协议层
// 用法：
//   node bin/headless-smoke.cjs             # 默认 ws://127.0.0.1:5175/__ai/ws
//   node bin/headless-smoke.cjs ws://...    # 指定 WS URL
//   node bin/headless-smoke.cjs --real      # 真发 fill（需服务端已启动 + 浏览器引擎就绪）
// 退出码：
//   0  — WS 连接 + headless:open 响应 + headless:state 帧均正常
//   1  — WS 连接失败
//   2  — 超时未收到 expect 帧
//   3  — 参数错误

const URL_DEFAULT = 'ws://127.0.0.1:5175/__ai/ws'
const TIMEOUT_MS = 8000

const L = require('../src/logger.cjs')

let WS
try { WS = require('ws') } catch { console.error('✗ 未安装 ws（pnpm add ws）'); process.exit(3) }
const { WebSocket } = WS

const args = process.argv.slice(2)
const real = args.includes('--real')
const url = args.find(a => !a.startsWith('--')) || URL_DEFAULT

function log(...a) { console.log(...a) }
function ok(m) { console.log(L.chalk.green('✓'), m) }
function err(m) { console.error(L.chalk.red('✗'), m) }
function step(m) { console.log(L.chalk.cyan('▶'), m) }

log('══ headless smoke ══')
log(`  URL: ${url}`)
log(`  模式: ${real ? 'real（发 fill）' : 'probe（仅 open + 空 fill）'}`)
log('')

const ws = new WebSocket(url)
const seen = new Set()

function finish(code) {
  try { ws.close() } catch { /* ignore */ }
  setTimeout(() => process.exit(code), 200)
}

const timer = setTimeout(() => {
  err(`超时 ${TIMEOUT_MS}ms 未收到完整期望帧`)
  log(`  已收到: ${[...seen].join(', ')}` || '(空)')
  finish(2)
}, TIMEOUT_MS)

ws.on('open', () => {
  ok('WS 连接成功')
  step('发 headless:open')
  ws.send(JSON.stringify({ t: 'headless:open', sid: 'smoke', url: 'about:blank' }))
})

ws.on('message', (raw) => {
  let msg
  try { msg = JSON.parse(String(raw)) } catch { return }
  const t = String(msg.t || '')
  seen.add(t)
  log(`  ← ${t}${msg.sid ? ` sid=${msg.sid}` : ''}${msg.state ? ` state=${msg.state}` : ''}${msg.detail ? ` (${String(msg.detail).slice(0, 60)})` : ''}`)

  // 阶段 1：收到 hello 或首次 state 后进入阶段 2
  if (!seen.has('phase1') && (t === 'hello' || t === 'headless:state')) {
    seen.add('phase1')
    step('发 headless:fill（空 prompt，只验证状态机）')
    ws.send(JSON.stringify({ t: 'headless:fill', sid: 'smoke', prompt: '' }))
  }

  // 阶段 2：收到 fill 结果（error 或 filling/generating）即算通过
  if (seen.has('phase1') && !seen.has('phase2') && t === 'headless:state') {
    seen.add('phase2')
    if (String(msg.state) === 'error') {
      ok('状态机验证通过（空 prompt 正确返回 error）')
    } else {
      ok(`状态机验证通过（state=${msg.state}）`)
    }
    if (real) {
      step('真发一条非空 fill（可能触发 429/超时，仅供参考）')
      ws.send(JSON.stringify({ t: 'headless:fill', sid: 'smoke', prompt: '请回复 DONE' }))
      // 不等 reply；收到下一条 state 或超时即结束
      setTimeout(() => {
        if (seen.has('headless:reply')) ok('收到 headless:reply')
        else log('  （未收到 reply，可能需真实浏览器上下文）')
        clearTimeout(timer)
        finish(0)
      }, 5000)
    } else {
      clearTimeout(timer)
      finish(0)
    }
  }
})

ws.on('error', (e) => {
  err(`WS 错误: ${String(e.message || e)}`)
  err('提示：确认 dev server 已启动（pnpm web:dev）+ ws-server 端口正确')
  finish(1)
})

process.on('SIGINT', () => { clearTimeout(timer); finish(0) })
