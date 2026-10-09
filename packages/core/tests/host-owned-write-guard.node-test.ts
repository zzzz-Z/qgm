// [host-owned-write-guard-v1] 门禁的承重判据：宿主独占文件被写时，必须留下 hostOwned 痕迹 + stderr 告警。
// WHY: 该门禁的全部价值在于「哪一次写入动了 SYSTEM.md」可被事后查账。若只断言源码里有这几个字，
//   改坏调用点也不会红（真空判据）。故此处用 vm 装一个假 fs 把 helpers.cjs 真跑起来，
//   走真实调用路径 writeText → _writeText → _changelog，再从假 fs 抓落盘记录。
// [CONSTRAINT] 假 fs 全程不触真盘 —— 绝不可以在测试里写真的 packages/core/SYSTEM.md。
// CHANGE-IMPACT: helpers.cjs 新增写入口时，若不经 _changelog 漏斗，本测试不会红（漏斗外的洞由
//   静态断言 #3 兜底）；新增宿主独占文件须同步 HOST_OWNED 与下方 EXPECTED_HOST_OWNED。
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const HELPERS = path.join(ROOT, 'packages', 'core', 'src', 'helpers.cjs')
// [helpers-index-v1] HOST_OWNED 与 _changelog 现活在 helpers/io.cjs（旧的 helpers-io.cjs 只剩转发壳）。
const HELPERS_IO = path.join(ROOT, 'packages', 'core', 'src', 'helpers', 'io.cjs')
const NL = String.fromCharCode(10)

const EXPECTED_HOST_OWNED = ['packages/core/SYSTEM.md']

interface Rec { p: string, s: string }

/** 在 vm 里加载 helpers.cjs，fs 全部换成记录型假实现；返回被记录的写入与 stderr 输出。 */
function loadSandbox() {
  const written: Rec[] = []
  // [helpers-index-v1] require 的解析基准目录：随加载者变化，模拟 Node 的模块相对解析。
  let currentDir = path.join(ROOT, 'packages', 'core', 'src')
  const appended: string[] = []
  const stderr: string[] = []
  const noop = () => undefined
  const fakeFs = {
    openSync: () => -1,
    readdirSync: () => [],
    mkdirSync: noop,
    writeFileSync: (p: string, s: string) => { written.push({ p, s }) },
    appendFileSync: (_p: string, s: string) => { appended.push(s) },
    existsSync: () => false,
    statSync: () => ({ isDirectory: () => false }),
    rmSync: noop,
    copyFileSync: noop,
    renameSync: noop,
    readFileSync: () => '',
    writeSync: noop,
  }
  const sandbox: Record<string, unknown> = {
    global: {},
    console: { log: noop, error: noop, warn: noop, info: noop },
    process: {
      cwd: () => ROOT,
      env: {},
      platform: 'darwin',
      stdout: {},
      stderr: { write: (s: string) => { stderr.push(String(s)) } },
      exit: noop,
    },
    require: (m: string) => {
      if (m === 'node:fs') return fakeFs
      if (m === 'node:path') return path
      if (m === 'node:child_process') return { execFileSync: () => '' }
      // [helpers-index-v1] 支持 helpers/ 目录结构：任意相对 .cjs 都按同一包装加载。
      //   helpers.cjs → ./helpers/index.cjs → ./io.cjs / ./shell.cjs / ./util.cjs 等。
      if (typeof m === 'string' && m.startsWith('./')) {
        // [helpers-index-v1] 相对加载者目录解析，模拟 Node 模块解析语义。
        //   helpers.cjs → ./helpers/index.cjs → ./io.cjs → helpers/io.cjs。
        const base = path.resolve(currentDir, m)
        const src = fs.readFileSync(base, 'utf8')
        const wrapped = `;(function(){ const module = { exports: {} };${src}; return module.exports })()`
        const prevDir = currentDir
        currentDir = path.dirname(base)
        try { return vm.runInContext(wrapped, sandbox, { filename: base }) }
        finally { currentDir = prevDir }
      }
      throw new Error(`unexpected require: ${m}`)
    },
  }
  vm.createContext(sandbox)
  // [helpers-index-v1] 顶层也走 module 壳：helpers.cjs 末尾 `module.exports = require(...)` 需要 module 存在。
  currentDir = path.dirname(HELPERS)
  const topSrc = fs.readFileSync(HELPERS, 'utf8')
  const topWrapped = `;(function(){ const module = { exports: {} };${topSrc}; return module.exports })()`
  vm.runInContext(topWrapped, sandbox, { filename: HELPERS })
  const ai = (sandbox.global as Record<string, unknown>).__AI__ as Record<string, (...a: unknown[]) => unknown>
  return { ai, written, appended, stderr }
}

// 单例：加载一次即可（模块内无跨调用状态污染本用例关心的路径）
let env: ReturnType<typeof loadSandbox>
beforeAll(() => { env = loadSandbox() })
afterAll(() => { expect(fs.readFileSync(path.join(ROOT, 'packages/core/SYSTEM.md'), 'utf8').length).toBeGreaterThan(0) })

describe('宿主独占写入门禁', () => {
  it('HOST_OWNED 恰为预期集合（新增须同步测试，防静默扩表）', () => {
    const src = fs.readFileSync(HELPERS_IO, 'utf8')
    const m = src.match(/const HOST_OWNED = new Set\(\[([^\]]*)\]\)/)
    expect(m, '未找到 HOST_OWNED 声明').not.toBeNull()
    const keys = (m as RegExpMatchArray)[1]
      .split(',')
      .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
    expect(keys).toEqual(EXPECTED_HOST_OWNED)
  })

  it('写宿主独占文件 → 落盘记录带 hostOwned 且 stderr 告警', () => {
    const target = path.join(ROOT, 'packages/core/SYSTEM.md')
    env.ai.writeText(target, 'dummy')
    const rec = env.written.find(w => w.p === target)
    expect(rec, '假 fs 未捕获到写入——调用路径变了').toBeTruthy()
    const line = env.appended.map(s => JSON.parse(s)).find(r => r.file === 'packages/core/SYSTEM.md')
    expect(line, 'changelog 未留痕').toBeTruthy()
    expect(line.hostOwned).toBe(true)
    expect(env.stderr.join('')).toContain('[host-owned-write]')
  })

  it('写普通文件 → 不带 hostOwned（反向验证，防恒真）', () => {
    const target = path.join(ROOT, 'packages/core/src/scratch.ts')
    env.ai.writeText(target, 'dummy')
    const line = env.appended.map(s => JSON.parse(s)).find(r => r.file === 'packages/core/src/scratch.ts')
    expect(line, 'changelog 未留痕').toBeTruthy()
    expect(line.hostOwned).toBeUndefined()
  })

  it('replaceInFile 也经漏斗（此前 5 个写入口中唯一不记账的）', () => {
    const src = fs.readFileSync(HELPERS_IO, 'utf8')
    const body = src.slice(src.indexOf('replaceInFile(p, opts)'), src.indexOf('module.exports'))
    expect(body, `replaceInFile 未调用 _changelog${NL}${body.slice(0, 400)}`).toContain('_changelog(\'replace\', p)')
  })
})
