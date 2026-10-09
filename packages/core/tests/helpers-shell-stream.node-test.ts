// [fg-stream-v1] 前台流式承重测试：opts.stream=true 时子进程输出实时出现在本进程 stdout。
// 承重性：删掉 runForeground 里的 `if (liveTee)` 分支，第 1 条必须变红。
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..', '..')
const HELPERS = path.join(ROOT, 'packages', 'core', 'src', 'helpers.cjs')

interface ShellResult { ok: boolean, stdout?: string, stderr?: string, code?: number }
interface AiApi {
  shell: (cmd: string | string[], opts?: Record<string, unknown>) => Promise<ShellResult>
}

const require = createRequire(import.meta.url)
require(HELPERS)
const AI = (globalThis as unknown as { __AI__: AiApi }).__AI__

/**
 * 劫持本进程 stdout 捕获实时字节；恢复函数由调用方放 finally，避免断言失败污染后续用例。
 * 只 spy 目标窗口内的写入，vitest 自身报告在窗口外，互不干扰。
 */
function spyStdout(): { chunks: string[], restore: () => void } {
  const chunks: string[] = []
  const orig = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((c: unknown) => { chunks.push(String(c)); return true }) as typeof process.stdout.write
  return { chunks, restore: () => { process.stdout.write = orig } }
}

it('fg-stream-v1: stream=true 时输出实时 tee 到本进程 stdout', async () => {
  const probe = 'process.stdout.write(\'LIVE_A\'); setTimeout(() => { process.stdout.write(\'LIVE_B\'); process.exit(0) }, 400)'
  const spy = spyStdout()
  let r: ShellResult
  try {
    r = await AI.shell(['node', '-e', probe], { stream: true })
  } finally {
    spy.restore()
  }
  assert.equal(r.code, 0, '探针应退出 0')
  assert.ok(String(r.stdout).includes('LIVE_A'), '返回体 stdout 应含 LIVE_A')
  assert.ok(String(r.stdout).includes('LIVE_B'), '返回体 stdout 应含 LIVE_B')
  const live = spy.chunks.join(String())
  assert.ok(live.includes('LIVE_A'), '实时通道缺 LIVE_A ⇒ 未 tee 到本进程 stdout')
  assert.ok(live.includes('LIVE_B'), '实时通道缺 LIVE_B ⇒ 未 tee 到本进程 stdout')
})

it('fg-stream-v1: 默认不 tee（零回归面）', async () => {
  const probe = 'process.stdout.write(\'QUIET\')'
  const spy = spyStdout()
  let r: ShellResult
  try {
    r = await AI.shell(['node', '-e', probe])
  } finally {
    spy.restore()
  }
  assert.equal(r.code, 0, '探针应退出 0')
  assert.ok(String(r.stdout).includes('QUIET'), '返回体仍应捕获输出')
  assert.equal(spy.chunks.join(String()), String(), '默认路径不得向本进程 stdout 写字节')
})

it('fg-stream-v1: stream 不改变退出码语义', async () => {
  const r = await AI.shell(['node', '-e', 'process.exit(3)'], { stream: true })
  assert.equal(r.code, 3)
  assert.equal(r.ok, false)
})
