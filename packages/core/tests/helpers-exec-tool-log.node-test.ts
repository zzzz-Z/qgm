// [helpers-exec-tool-log-v1] S1 守卫：__AI__.exec 调用会写入 toolLog 的 exec 记录
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, it } from 'vitest'

const require = createRequire(import.meta.url)
let tmpDir = ''
let logPath = ''

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcheck-log-'))
  logPath = path.join(tmpDir, 'probe-tools.jsonl')
  process.env.AI_RUNNER_TOOL_LOG = logPath
  // [helpers-index-v1] 清 helpers/ 全量 require 缓存：toolLog 的 _TOOL_FD 现活在
  //   helpers/util.cjs，只清入口 helpers.cjs 无法重跑 _openToolLog（旧路径会残留）。
  const helpersModules = [
    '../src/helpers.cjs',
    '../src/helpers/index.cjs',
    '../src/helpers/util.cjs',
    '../src/helpers/io.cjs',
    '../src/helpers/shell.cjs',
    '../src/helpers/search.cjs',
    '../src/helpers/state.cjs',
    '../src/helpers/output.cjs',
    '../src/helpers/patch.cjs',
  ]
  for (const m of helpersModules) {
    try { delete require.cache[require.resolve(m)] } catch { /* ignore */ }
  }
  require('../src/helpers.cjs')
})

afterEach(() => {
  delete process.env.AI_RUNNER_TOOL_LOG
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

it('S1: __AI__.exec 调用会追加 exec 记录到 toolLog', async () => {
  const api = (globalThis as unknown as { __AI__?: { exec: (cmd: string, args: string[], opts?: Record<string, unknown>) => Promise<unknown> } }).__AI__
  assert.ok(api, '__AI__ 未挂载')
  await api!.exec('echo', ['probe-hello'], {})
  assert.ok(fs.existsSync(logPath), 'toolLog 文件未生成')
  const txt = fs.readFileSync(logPath, 'utf8')
  const lines = txt.split('\n').filter(Boolean)
  assert.ok(lines.length >= 1, '至少 1 条记录')
  const first = JSON.parse(lines[0])
  assert.equal(first.op, 'exec')
  assert.equal(first.cmd, 'echo')
  assert.ok(String(first.flat).includes('echo'))
  assert.ok(String(first.flat).includes('probe-hello'))
})

it('S1: 两次 exec 均被记录（累计写入）', async () => {
  const api = (globalThis as unknown as { __AI__?: { exec: (cmd: string, args: string[], opts?: Record<string, unknown>) => Promise<unknown> } }).__AI__
  assert.ok(api, '__AI__ 未挂载')
  await api!.exec('echo', ['first-call'], {})
  await api!.exec('echo', ['second-call'], {})
  const content = fs.readFileSync(logPath, 'utf8')
  assert.ok(content.includes('first-call'), '第一次未被记录')
  assert.ok(content.includes('second-call'), '第二次未被记录')
})
