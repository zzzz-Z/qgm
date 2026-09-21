'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

let proc = null
async function loadProc() {
  if (proc) return proc
  const tsPath = path.join(__dirname, 'proc.ts')
  const tsSrc = fs.readFileSync(tsPath, 'utf8')
  const { stripTypeScriptTypes } = require('node:module')
  const js = stripTypeScriptTypes(tsSrc, { mode: 'strip' })
  const url = `data:text/javascript;base64,${Buffer.from(js, 'utf8').toString('base64')}`
  proc = await import(url)
  return proc
}

test('基础执行：stdout / stderr / code 分离', async () => {
  const { runProcess } = await loadProc()
  const r = await runProcess(process.execPath, {
    args: ['-e', 'process.stdout.write("OUT");process.stderr.write("ERR")'],
  })
  assert.equal(r.code, 0)
  assert.equal(r.stdout, 'OUT')
  assert.equal(r.stderr, 'ERR')
  assert.equal(r.killed, false)
})

test('非零退出码透传', async () => {
  const { runProcess } = await loadProc()
  const r = await runProcess(process.execPath, {
    args: ['-e', 'process.exit(3)'],
  })
  assert.equal(r.code, 3)
})

test('onChunk 按数据到达顺序回调 stdout / stderr', async () => {
  const { runProcess } = await loadProc()
  const events = []
  const body = [
    'process.stdout.write("o1")',
    'setTimeout(function(){process.stderr.write("e1");setTimeout(function(){process.stdout.write("o2")},30)},30)',
  ].join(';')
  await runProcess(process.execPath, {
    args: ['-e', body],
    onChunk: (s, d) => events.push([s, d]),
  })
  const outOrder = events.filter(e => e[0] === 'stdout').map(e => e[1]).join('')
  const errOrder = events.filter(e => e[0] === 'stderr').map(e => e[1]).join('')
  assert.equal(outOrder, 'o1o2')
  assert.equal(errOrder, 'e1')
})

test('timeout：到点 SIGTERM，宽限期到点 SIGKILL 升级', async () => {
  const { runProcess } = await loadProc()
  const t0 = Date.now()
  const r = await runProcess(process.execPath, {
    args: ['-e', 'process.on("SIGTERM",function(){});setInterval(function(){},1000)'],
    timeoutMs: 300,
    killGraceMs: 200,
    timeoutLabel: '单测超时',
  })
  const dt = Date.now() - t0
  assert.ok(dt >= 300 && dt < 3000, `应被超时中止，实际 ${dt}ms`)
  assert.equal(r.killed, true)
  assert.ok(r.stderr.includes('单测超时'), `stderr 应带超时标签，实际: ${r.stderr}`)
})

test('signal.abort 立即 SIGKILL，不等待宽限', async () => {
  const { runProcess } = await loadProc()
  const ac = new AbortController()
  const t0 = Date.now()
  setTimeout(() => ac.abort(), 150)
  const r = await runProcess(process.execPath, {
    args: ['-e', 'setInterval(function(){},1000)'],
    signal: ac.signal,
  })
  const dt = Date.now() - t0
  assert.ok(dt < 2000, `abort 应尽快结束，实际 ${dt}ms`)
  assert.equal(r.killed, true)
})

test('命令不存在：code -1，stderr 非空', async () => {
  const { runProcess } = await loadProc()
  const r = await runProcess(`definitely-not-a-real-cmd-${Date.now()}`)
  assert.equal(r.code, -1)
  assert.ok(r.stderr.length > 0)
})

test('stdin 字符串被写入子进程', async () => {
  const { runProcess } = await loadProc()
  const body = 'process.stdin.setEncoding("utf8");var b="";process.stdin.on("data",function(d){b+=d});process.stdin.on("end",function(){process.stdout.write(b+"|EOF")})'
  const r = await runProcess(process.execPath, {
    args: ['-e', body],
    stdin: 'hello',
  })
  assert.equal(r.stdout, 'hello|EOF')
})

test('shell:true 支持 shell 语法', async () => {
  const { runProcess } = await loadProc()
  const r = await runProcess('echo hello-shell', { shell: true })
  assert.equal(r.code, 0)
  assert.ok(r.stdout.includes('hello-shell'))
})

test('detectPackageManager：pnpm-lock.yaml 优先于 yarn.lock', async () => {
  const { detectPackageManager } = await loadProc()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'air-proc-'))
  const oldExec = process.env.npm_execpath
  try {
    delete process.env.npm_execpath
    assert.equal(detectPackageManager(dir), 'npm')
    fs.writeFileSync(path.join(dir, 'yarn.lock'), '')
    assert.equal(detectPackageManager(dir), 'yarn')
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '')
    assert.equal(detectPackageManager(dir), 'pnpm')
  } finally {
    if (oldExec !== undefined) process.env.npm_execpath = oldExec
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
