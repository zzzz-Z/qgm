// AIRUNNER-BATCH26-9-INTER
// AIRUNNER-BATCH26-2-FIX-REQUIRE
// AIRUNNER-BATCH26-CJS-TO-VITEST: 从 src/interceptor.test.cjs 迁至 test/server/interceptor.test.ts
// 拦截器沙盒测试：在子进程里 -r 预加载 interceptor.cjs，校验所有写删 API
// 都只进 overlay JSON、真实磁盘零改动。
import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// AIRUNNER-BATCH26-CJS-TO-VITEST: CJS __dirname 等价写法
import { fileURLToPath } from 'node:url'

import { it } from 'vitest'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// AIRUNNER-BATCH26-9-INTER: 测试在 test/server/，interceptor.cjs 在仓库根
// AIRUNNER-BATCH27-5: interceptor.cjs 真身在 src/，非仓库根
// [mig-path-v1] 测试从 test/server/ 迁到 packages/core/tests/，__dirname 深一级 → 路径多 1 级上溯
const interceptor = path.resolve(__dirname, '..', '..', '..', 'packages', 'core', 'src', 'interceptor.cjs')

function runInSandbox(scriptBody: string, setup?: (dir: string) => void) {
  // realpath：macOS 下 /var、/tmp 是软链，子进程 process.cwd() 返回物理路径
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'air-int-')))
  if (setup) setup(dir)
  const overlay = path.join(dir, 'overlay.json')
  const r = spawnSync(process.execPath, ['-r', interceptor, '-e', scriptBody], {
    cwd: dir,
    env: { ...process.env, AI_RUNNER_OVERLAY: overlay },
    encoding: 'utf8',
  })
  const entries = fs.existsSync(overlay) ? JSON.parse(fs.readFileSync(overlay, 'utf8')) : {}
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, entries, dir }
}

it('writeFileSync 只进 overlay，磁盘零改动', () => {
  const r = runInSandbox(`
    const fs = require('fs')
    fs.writeFileSync('a.txt', 'hello')
  `)
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!fs.existsSync(path.join(r.dir, 'a.txt')), '磁盘不应出现 a.txt')
  const e = r.entries[path.join(r.dir, 'a.txt')]
  assert.ok(e && e.op === 'write')
  assert.equal(Buffer.from(e.data, 'base64').toString(), 'hello')
  fs.rmSync(r.dir, { recursive: true, force: true })
})

it('appendFileSync 与已有 overlay 内容合并', () => {
  const r = runInSandbox(`
    const fs = require('fs')
    fs.writeFileSync('b.txt', 'foo')
    fs.appendFileSync('b.txt', 'bar')
  `)
  assert.equal(r.status, 0, r.stderr)
  const e = r.entries[path.join(r.dir, 'b.txt')]
  assert.equal(Buffer.from(e.data, 'base64').toString(), 'foobar')
  fs.rmSync(r.dir, { recursive: true, force: true })
})

it('失败退出（exit 1）overlay 仍 dump 且磁盘零改动', () => {
  const r = runInSandbox(`
    const fs = require('fs')
    fs.writeFileSync('c.txt', 'boom')
    process.exit(1)
  `)
  assert.equal(r.status, 1)
  assert.ok(!fs.existsSync(path.join(r.dir, 'c.txt')))
  assert.ok(r.entries[path.join(r.dir, 'c.txt')])
  fs.rmSync(r.dir, { recursive: true, force: true })
})

it('createWriteStream 写入在 finish 后进入 overlay', () => {
  const r = runInSandbox(`
    const fs = require('fs')
    const ws = fs.createWriteStream('d.txt')
    ws.on('open', (fd) => {
      ws.write('line1\\n')
      ws.end('line2')
    })
    ws.on('error', (e) => { console.error(e); process.exit(2) })
  `)
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!fs.existsSync(path.join(r.dir, 'd.txt')))
  const e = r.entries[path.join(r.dir, 'd.txt')]
  assert.ok(e, 'overlay 应包含 d.txt')
  assert.equal(Buffer.from(e.data, 'base64').toString(), 'line1\nline2')
  fs.rmSync(r.dir, { recursive: true, force: true })
})

it('openSync(写) + writeSync + closeSync 进 overlay；读模式仍走真实 fd', () => {
  const r = runInSandbox(`
    const fs = require('fs')
    const fd = fs.openSync('e.txt', 'w')
    fs.writeSync(fd, 'part1')
    fs.writeSync(fd, Buffer.from('part2'))
    fs.closeSync(fd)
    // 读模式必须返回真实可读 fd（real.txt 由 setup 写在真实磁盘上）
    const rfd = fs.openSync('real.txt', 'r')
    const buf = Buffer.alloc(4)
    const n = fs.readSync(rfd, buf, 0, 4, 0)
    fs.closeSync(rfd)
    if (buf.slice(0, n).toString() !== 'REAL') process.exit(3)
  `, (dir: string) => {
    fs.writeFileSync(path.join(dir, 'real.txt'), 'REAL')
  })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!fs.existsSync(path.join(r.dir, 'e.txt')))
  const e = r.entries[path.join(r.dir, 'e.txt')]
  assert.equal(Buffer.from(e.data, 'base64').toString(), 'part1part2')
  // real.txt 是预置真实文件，读 fd 走原生日理应当保持原样
  assert.equal(fs.readFileSync(path.join(r.dir, 'real.txt'), 'utf8'), 'REAL')
  fs.rmSync(r.dir, { recursive: true, force: true })
})

it('fs.promises.writeFile 与 callback fs.writeFile 都被拦截', async () => {
  const r = runInSandbox(`
    const fs = require('fs')
    const util = require('util')
    ;(async () => {
      await fs.promises.writeFile('p.txt', 'promise')
      await util.promisify(fs.writeFile)('q.txt', 'callback')
    })().catch((e) => { console.error(e); process.exit(4) })
  `)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(Buffer.from(r.entries[path.join(r.dir, 'p.txt')].data, 'base64').toString(), 'promise')
  assert.equal(Buffer.from(r.entries[path.join(r.dir, 'q.txt')].data, 'base64').toString(), 'callback')
  fs.rmSync(r.dir, { recursive: true, force: true })
})

it('rmSync 目录标记 dir:true 且真实目录保留', () => {
  const r = runInSandbox(`
    const fs = require('fs')
    fs.rmSync('sub', { recursive: true, force: true })
  `, (dir: string) => {
    fs.mkdirSync(path.join(dir, 'sub'))
    fs.writeFileSync(path.join(dir, 'sub', 'inside.txt'), 'x')
  })
  assert.equal(r.status, 0, r.stderr)
  // 磁盘零改动：目录和文件都还在
  assert.ok(fs.existsSync(path.join(r.dir, 'sub', 'inside.txt')))
  const e = r.entries[path.join(r.dir, 'sub')]
  assert.ok(e && e.op === 'delete' && e.dir === true)
  fs.rmSync(r.dir, { recursive: true, force: true })
})

it('unlinkSync 删除标记且 readFileSync 读到 ENOENT 视图', () => {
  const r = runInSandbox(`
    const fs = require('fs')
    fs.unlinkSync('gone.txt')
    if (fs.existsSync('gone.txt')) process.exit(5)
    try { fs.readFileSync('gone.txt'); process.exit(6) } catch (e) { if (e.code !== 'ENOENT') process.exit(7) }
  `, (dir: string) => {
    fs.writeFileSync(path.join(dir, 'gone.txt'), 'old')
  })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(fs.existsSync(path.join(r.dir, 'gone.txt')), '真实文件应保留')
  assert.deepEqual(r.entries[path.join(r.dir, 'gone.txt')], { op: 'delete', data: null, dir: false })
  fs.rmSync(r.dir, { recursive: true, force: true })
})

// [readonly-write-regression-v1] read-only 沙盒下「经 __AI__ helpers 写入」必须零落盘。
// 承重：历史上实测过一次「只传 env 不 -r interceptor」导致 read-only 形同虚设（真写盘）；
//   本组第一条在那种回归下会变红。第二条是阳性对照——同一脚本在 full 下确实写盘，
//   否则第一条可能因为 writeText 自身坏掉而「假绿」。
function runWithHelpers(scriptBody: string, opts?: { env?: Record<string, string>, setup?: (dir: string) => void }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'air-ro-')))
  if (opts && opts.setup) opts.setup(dir)
  const overlay = path.join(dir, 'overlay.json')
  const helpers = path.resolve(__dirname, '..', '..', '..', 'packages', 'core', 'src', 'helpers.cjs')
  const r = spawnSync(process.execPath, ['-r', interceptor, '-r', helpers, '-e', scriptBody], {
    cwd: dir,
    env: { ...process.env, AI_RUNNER_OVERLAY: overlay, AI_RUNNER_TOOL_LOG: '', ...(opts && opts.env) },
    encoding: 'utf8',
  })
  const entries = fs.existsSync(overlay) ? JSON.parse(fs.readFileSync(overlay, 'utf8')) : {}
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, entries, dir }
}

it('read-only：__AI__.writeText 只进 overlay，磁盘零改动', () => {
  const r = runWithHelpers('__AI__.writeText(\'ro.txt\', \'hello\')')
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!fs.existsSync(path.join(r.dir, 'ro.txt')), 'read-only 下磁盘不应出现 ro.txt')
  const e = r.entries[path.join(r.dir, 'ro.txt')]
  assert.ok(e && e.op === 'write', 'overlay 应记录 ro.txt')
  assert.equal(Buffer.from(e.data, 'base64').toString(), 'hello')
  fs.rmSync(r.dir, { recursive: true, force: true })
})

it('阳性对照：同一脚本在 full 沙盒下确实写盘', () => {
  const r = runWithHelpers('__AI__.writeText(\'fw.txt\', \'hello\')', { env: { AI_RUNNER_SANDBOX: 'full' } })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(fs.readFileSync(path.join(r.dir, 'fw.txt'), 'utf8'), 'hello')
  fs.rmSync(r.dir, { recursive: true, force: true })
})
