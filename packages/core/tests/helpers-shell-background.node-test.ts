// [ai-shell-async-v1] 后台执行 + 跨轮轮询承重测试：
//   验证 background 模式即发即返、日志落盘、shellStatus/readShell 可查、[@shell-done] 哨兵、killShell 取消。
//   参照 Claude Code run_in_background / OpenHands 后台 shell：任务即发即返，状态落盘，靠轮询收口。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, it } from 'vitest'

const NL = String.fromCharCode(10)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..', '..')
const HELPERS = path.join(ROOT, 'packages', 'core', 'src', 'helpers.cjs')

interface ShellHandle { ok: boolean, background?: boolean, id?: string, pid?: number, logPath?: string }
interface ShellStatus { ok: boolean, running?: boolean, exitCode?: number }
interface ShellLog { ok: boolean, text?: string, next?: number, done?: boolean, running?: boolean, exitCode?: number }
interface AiApi {
  shell: (cmd: string | string[], opts?: Record<string, unknown>) => Promise<ShellHandle>
  shellStatus: (id: string) => ShellStatus
  readShell: (id: string, opts?: { from?: number }) => ShellLog
  killShell: (id: string) => { ok: boolean }
}

const require = createRequire(import.meta.url)
require(HELPERS)
const AI = (globalThis as unknown as { __AI__: AiApi }).__AI__

async function waitDone(id: string, ms = 8000): Promise<ShellStatus> {
  const t0 = Date.now()
  while (true) {
    const st = AI.shellStatus(id)
    if (st.ok && !st.running) return st
    if (Date.now() - t0 > ms) return st
    await new Promise((r) => { setTimeout(r, 50) })
  }
}

const ids: string[] = []
afterAll(() => {
  for (const id of ids) { try { AI.killShell(id) } catch { /* ignore */ } }
})

it('background: 即发即返 + 日志落盘 + [@shell-done] 哨兵', async () => {
  const h = await AI.shell(['sh', '-c', 'echo hi; sleep 0.3; echo bye'], { background: true })
  assert.ok(h.ok, 'background 启动应 ok')
  assert.equal(h.background, true)
  assert.ok(h.id, '应返回 id')
  assert.ok(h.logPath, '应返回 logPath')
  ids.push(h.id!)

  // 立即返回（命令尚未跑完 0.3s）：状态应 running
  const early = AI.shellStatus(h.id!)
  assert.equal(early.ok, true)
  assert.equal(early.running, true)

  const st = await waitDone(h.id!)
  assert.equal(st.running, false, '应在超时内结束')
  assert.equal(st.exitCode, 0)

  const log = AI.readShell(h.id!, { from: 0 })
  assert.equal(log.ok, true)
  assert.equal(log.done, true)
  assert.ok(String(log.text).includes('hi'), '日志含 hi')
  assert.ok(String(log.text).includes('bye'), '日志含 bye')
  assert.ok(String(log.text).includes('[@shell-done exit=0'), '含完成哨兵')
}, 15000)

// [bg-sentinel-v1] 承重判据：父进程（/run 脚本）退出后，后台任务仍要能被后续轮次收口。
//   WHY 后台模式的典型用法就是「本轮发出、下一轮轮询」；若完成状态只靠父进程的 exit 处理器，
//        父进程一走，status.json 就永远停在 running:true —— AI 会一直等一个早跑完的任务。
//   判据：独立 node 子进程起后台任务后立即 exit(0)，本进程（从未见过该子进程）轮询 shellStatus
//        必须看到 running:false + exitCode=0 + 日志里有 [@shell-done] 哨兵。
it('bg-sentinel-v1: 父进程退出后仍能收口（跨轮轮询的前提）', async () => {
  const inner = [
    'const path = require(\'node:path\')',
    'require(path.resolve(process.cwd(), \'packages/core/src/helpers.cjs\'))',
    'global.__AI__.shell([\'sh\', \'-c\', \'echo hi; sleep 0.6; echo bye\'], { background: true })'
    + '.then((h) => { process.stdout.write(JSON.stringify(h)); process.exit(0) })',
  ].join(NL)
  const r = spawnSync(process.execPath, ['-e', inner], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0, `探针子进程失败：${String(r.stderr)}`)
  // [bg-stream-v1] background 模式会额外向 stdout 打一行 `BG_ID=<id>`（前端据此起轮询）⇒
  //   此处不能整体 JSON.parse；顺带把它当判据：标记缺失则前端永远拿不到 id，流式显示无从发生。
  const outLines = String(r.stdout).split('\n').map(s => s.trim())
  assert.ok(outLines.some(s => s.startsWith('BG_ID=sh-')), 'background 未向 stdout 打 BG_ID 标记 ⇒ 前端无从发起轮询')
  const h = JSON.parse(outLines.find(s => s.startsWith('{')) || '{}') as ShellHandle
  assert.ok(h.id, '未拿到后台任务 id')
  ids.push(h.id!)

  const st = await waitDone(h.id!, 10000)
  assert.equal(st.running, false, '父进程已退出，任务仍被判定为 running（跨轮收口失败）')
  assert.equal(st.exitCode, 0, `退出码应从子进程自写的哨兵里取到，实际 ${String(st.exitCode)}`)
  const log = AI.readShell(h.id!, { from: 0 })
  assert.ok(String(log.text).includes('[@shell-done exit=0'), '子进程未自写完成哨兵')
  assert.ok(String(log.text).includes('bye'), '日志不完整（任务输出被截断）')
}, 20000)

it('killShell: 取消长时间后台任务', async () => {
  const h = await AI.shell(['sh', '-c', 'sleep 30; echo never'], { background: true })
  assert.ok(h.ok)
  ids.push(h.id!)
  assert.equal(AI.shellStatus(h.id!).running, true, '启动后应 running')
  const k = AI.killShell(h.id!)
  assert.equal(k.ok, true, 'killShell 应成功')
  const st = await waitDone(h.id!, 5000)
  assert.equal(st.running, false, '被杀后应变为非 running')
})
