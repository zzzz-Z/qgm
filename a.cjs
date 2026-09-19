#!/usr/bin/env node
// @desc: 重建 client/utils/pricing.ts（formatCost / estimateCost / PRICING / Usage）
// @why: ScriptPanel.vue:403 import formatCost 但文件全盘丢失；按 PLAN.md A.17 + 用法重建
// @plan: pricing.ts 重建

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const TTY = Boolean(process.stdout.isTTY)
const C = { reset: TTY ? '\x1b[0m' : '', green: TTY ? '\x1b[32m' : '', yellow: TTY ? '\x1b[33m' : '', red: TTY ? '\x1b[31m' : '' }
const ok = m => console.log(C.green + '✓' + C.reset + ' ' + m)
const skip = m => console.log(C.yellow + '!' + C.reset + ' ' + m)
const err = m => console.error(C.red + '✗' + C.reset + ' ' + m)

const REL = 'client/utils/pricing.ts'
const ABS = path.join(ROOT, REL)

if (process.argv.includes('--rollback')) {
  if (fs.existsSync(ABS)) { fs.unlinkSync(ABS); ok('已删除 ' + REL) }
  else skip(REL + ' 不存在')
  process.exit(0)
}

console.log('▶ 检查')
if (fs.existsSync(ABS)) {
  skip(REL + ' 已存在，跳过')
  process.exit(0)
}

const SRC = `export interface Price { input: number, output: number }

/**
 * 单价表：input/output 均为「元 / token」。
 * 未列出的模型 estimateCost 返回 null（调用方显示 token 数不显示金额）。
 */
export const PRICING: Record<string, Price> = {
  'deepseek-chat': { input: 1e-6, output: 2e-6 },
  'deepseek-reasoner': { input: 4e-6, output: 16e-6 },
}

export interface Usage { prompt_tokens: number, completion_tokens: number }

export function estimateCost(model: string, usage: Usage): number | null {
  const p = PRICING[model]
  if (!p) return null
  const inTok = Math.max(0, Number(usage.prompt_tokens) || 0)
  const outTok = Math.max(0, Number(usage.completion_tokens) || 0)
  return inTok * p.input + outTok * p.output
}

export function formatCost(yuan: number | null): string {
  if (yuan === null || yuan === undefined) return '未知'
  if (!Number.isFinite(yuan)) return '未知'
  if (yuan < 0.01) return '<¥0.01'
  return '¥' + yuan.toFixed(2)
}
`

console.log('▶ 写入 ' + REL)
fs.mkdirSync(path.dirname(ABS), { recursive: true })
fs.writeFileSync(ABS, SRC)

console.log('▶ 自检')
const written = fs.readFileSync(ABS, 'utf8')
const checks = [
  ['含 PRICING 常量', /export\s+const\s+PRICING/.test(written)],
  ['含 Price 接口', /export\s+interface\s+Price/.test(written)],
  ['含 Usage 接口', /export\s+interface\s+Usage/.test(written)],
  ['含 estimateCost', /export\s+function\s+estimateCost/.test(written)],
  ['含 formatCost', /export\s+function\s+formatCost/.test(written)],
  ['formatCost 处理 null', /yuan\s*===\s*null/.test(written)],
  ['deepseek-chat 单价', /'deepseek-chat'/.test(written)],
  ['deepseek-reasoner 单价', /'deepseek-reasoner'/.test(written)],
]
let allOk = true
for (const [n, p] of checks) { if (p) ok(n); else { err(n); allOk = false } }
if (!allOk) { err('自检失败'); process.exit(1) }

ok(REL + ' 已创建 (' + written.length + ' 字节)')
console.log('▶ 下一步：pnpm tsc；浏览器 Cmd+Shift+R 硬刷新')