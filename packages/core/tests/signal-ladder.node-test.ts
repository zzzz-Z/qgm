// [signal-gate-v1] 阶段 4 观察期的信号闸门守卫。
// WHY: bin/check-status.cjs 的结论段自述「阶段 0 - 3.2 产物到位，阶段 4 观察期就绪；
//   规则：>= 2 周不做新功能；仅触发信号达阈值时开下一阶段」。该闸门的全部实现 =
//   一枚阈值阶梯（bin/log-signal.cjs）+ 一个记录器。但实测（2026-10-05）：
//   .ai-runner/signals.md 从未存在、log-signal.cjs 全仓零调用、空状态下 report() 提前
//   return 连阶梯都不打印 ⇒ 机制不可发现 = 不可能被触发 ⇒「开新阶段」只能靠拍脑袋。
// CHANGE-IMPACT: 钉三件事——阶梯恒定可见 / 记录闭环可用 / 两份阈值表不许漂移。
//   两个脚本都以 process.cwd() 为 ROOT，故 spawn 到临时 cwd，不依赖运行态 .ai-runner/。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const LOG_SIGNAL = path.join(ROOT, 'bin', 'log-signal.cjs')
const CHECK_STATUS = path.join(ROOT, 'bin', 'check-status.cjs')

// [阈值依据 2026-10-05] 类别与阈值取自 bin/log-signal.cjs 的 THRESHOLDS（SSOT）：
//   manual-copy 3（→ 阶段 6 API 循环）/ style-regress 2（→ 视觉回归）/
//   prompt-budget 3（→ 阶段 5 多层级压缩）。
//   [CONSTRAINT] 断言写字面量而非从源码导入——否则改源码时期望值同步变，判据永不红。
const CATEGORIES = ['manual-copy', 'style-regress', 'prompt-budget']
const NEED: Record<string, string> = { 'manual-copy': '3', 'style-regress': '2', 'prompt-budget': '3' }

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'signal-ladder-'))
}

function run(script: string, args: string[], cwd: string): { status: number | null, stdout: string, stderr: string } {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' })
  return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') }
}

/**
 * 两份脚本都打 `<cat> <n>/<need>`，据此抽出 cat → need。
 * 颜色只包在 mark 上、不落在 cat 与 n 之间，故无需剥 ANSI。
 */
function parseNeed(stdout: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    const m = line.match(/([\w-]+)\s+(\d+)\/(\d+)/)
    if (m && CATEGORIES.includes(m[1])) out[m[1]] = m[3]
  }
  return out
}

describe('阶段 4 观察期的信号闸门', () => {
  it('无任何记录时也必须打印完整阈值阶梯（空状态不许把机制藏起来）', () => {
    const r = run(LOG_SIGNAL, [], tmpRoot())
    expect(r.status, r.stderr).toBe(0)
    const ladder = parseNeed(r.stdout)
    expect(Object.keys(ladder).sort()).toEqual([...CATEGORIES].sort())
    for (const cat of CATEGORIES) expect(ladder[cat]).toBe(NEED[cat])
    expect(r.stdout).toContain('记录入口')
  })

  it('记录闭环可用：追加一条后同一进程的 report 就把它计为 1/need', () => {
    const cwd = tmpRoot()
    const r = run(LOG_SIGNAL, ['prompt-budget', 'selftest'], cwd)
    expect(r.status, r.stderr).toBe(0)
    const file = path.join(cwd, '.ai-runner', 'signals.md')
    expect(fs.existsSync(file), '记录后信号台账应被创建').toBe(true)
    const body = fs.readFileSync(file, 'utf8')
    expect(body).toContain('[prompt-budget]')
    expect(body).toContain('selftest')
    expect(r.stdout).toMatch(/prompt-budget\s+1\/3/)
  })

  // [ladder-parity-v2] 两个入口都打印阶梯，故两者必须同时可见 + 阈值一致。
  // WHY: v1 版在此处先 writeFileSync 造出 signals.md（模拟「有记录」），于是绕过了
  //   check-status.cjs 的「文件不存在即 info + return」早退分支——恰好把最该暴露的
  //   空状态藏了起来。这与它自己结论段「仅触发信号达阈值时开下一阶段」互相矛盾：
  //   一次都没记过的项目看不到阶梯，就等于看不到阶段 4 的全部内容。
  // CHANGE-IMPACT: 改为不预建文件。此改动使本用例对「空状态可见性」承重。
  it('两个入口在空状态下都可见完整阶梯，且阈值表一致（同一规则不许两处漂移）', () => {
    const cwd = tmpRoot()
    const fromLog = parseNeed(run(LOG_SIGNAL, [], cwd).stdout)
    const fromCheck = parseNeed(run(CHECK_STATUS, [], cwd).stdout)
    expect(Object.keys(fromLog).sort(), 'log-signal 空状态须可见阶梯').toEqual([...CATEGORIES].sort())
    expect(Object.keys(fromCheck).sort(), 'check-status 空状态同样不许把阶梯藏起来').toEqual([...CATEGORIES].sort())
    expect(fromCheck).toEqual(fromLog)
  })
})
