// [server-bootstrap-guard-v1] 服务**启动期**的三条不变量守卫：客户端入口候选（D5）、SPA 根候选（D10）、
// 进程级异常兜底（D8）。
// [WHY] 这三条都属于「源码态恒真、打包态才炸」的族：vitest / tsc / 本地 dev 全在源码态跑，
//   任何一条坏了单测都不会红（D5/D10 实测就是这样潜伏下来的）。
// [CONSTRAINT] apps/standalone/src/server.ts 不可被 import —— 它在模块顶层 listen，
//   故 D8/D10 走「剥注释后的源码断言」，D5 走 page.ts 的纯函数（可真实调用）。
// CHANGE-IMPACT: 删掉任一候选路径 / 任一 process.on 兜底，本文件必须变红。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { clientMainCandidates, pickClientMain } from '../../../packages/core/src/server/page.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SERVER_TS = path.join(ROOT, 'apps', 'standalone', 'src', 'server.ts')

/** 剥掉行注释与块注释的源码：避免「注释里提到过」被判成「代码里做了」 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

const SERVER_CODE = stripComments(fs.readFileSync(SERVER_TS, 'utf8'))

/** 取 `const <name> = [` 之后的数组字面量（方括号配对扫描，正则会被嵌套括号骗） */
function arrayLiteral(code: string, name: string): string {
  const at = code.indexOf(`const ${name} = [`)
  assert.ok(at >= 0, `server.ts 缺少 const ${name} = [...]`)
  const start = code.indexOf('[', at)
  let depth = 0
  for (let i = start; i < code.length; i += 1) {
    if (code[i] === '[') { depth += 1 }
    else if (code[i] === ']') {
      depth -= 1
      if (depth === 0) return code.slice(start, i + 1)
    }
  }
  throw new Error(`const ${name} 的数组字面量未闭合`)
}

// ---------- D5：客户端入口候选（page.ts 纯函数） ----------

// [合成根] 与真实布局同深度：<root>/apps/standalone/dist/_server
// 用合成根是为了让「4 级上溯候选」成为 packages/client/main.ts 的**唯一**来源 ——
// 若用真实 ROOT，cwd 候选也会命中同一个文件，删掉 4 级候选测试仍然绿（判据不承重）。
const FAKE_ROOT = '/tmp/fake-repo'
const PACKAGED_PKG_DIR = path.join(FAKE_ROOT, 'apps', 'standalone', 'dist', '_server')

test('clientMainCandidates: 打包态 pkgDir 下仍包含仓库入口（4 级上溯候选）', () => {
  const cands = clientMainCandidates(PACKAGED_PKG_DIR, '/tmp/elsewhere')
  const expected = path.join(FAKE_ROOT, 'packages', 'client', 'main.ts')
  assert.ok(
    cands.includes(expected),
    `候选中缺少 ${expected}（打包态唯一可用的入口）；实际候选：\n  ${cands.join('\n  ')}`,
  )
})

test('clientMainCandidates: 源码态与打包态的第一候选不是同一个路径（层级差异真实存在）', () => {
  const src = clientMainCandidates(path.join(FAKE_ROOT, 'packages', 'core', 'src', 'server'), '/tmp/elsewhere')
  const pkg = clientMainCandidates(PACKAGED_PKG_DIR, '/tmp/elsewhere')
  assert.notEqual(src[0], pkg[0], '两条形态的首候选相同 ⇒ 说明层级差异没被候选列表覆盖')
  assert.ok(src[0].endsWith(path.join('packages', 'client', 'main.ts')), `源码态首候选应命中仓库入口，实际 ${src[0]}`)
})

test('clientMainCandidates: AI_RUNNER_CLIENT_MAIN 优先级最高（唯一候选）', () => {
  const old = process.env.AI_RUNNER_CLIENT_MAIN
  try {
    process.env.AI_RUNNER_CLIENT_MAIN = '/tmp/injected-main.ts'
    assert.deepEqual(clientMainCandidates(PACKAGED_PKG_DIR, FAKE_ROOT), ['/tmp/injected-main.ts'])
  } finally {
    if (old === undefined) delete process.env.AI_RUNNER_CLIENT_MAIN
    else process.env.AI_RUNNER_CLIENT_MAIN = old
  }
})

test('pickClientMain: 只有打包态候选存在时选中它，而不是盲取首个', () => {
  const cands = ['/nope/a.ts', '/nope/b.ts', '/nope/c.ts']
  assert.equal(pickClientMain(cands, p => p === '/nope/b.ts'), '/nope/b.ts')
})

test('pickClientMain: 全部不存在时回落首个候选（保持旧行为可见，不抛错）', () => {
  assert.equal(pickClientMain(['/nope/a.ts', '/nope/b.ts'], () => false), '/nope/a.ts')
})

// ---------- D10：SPA 根候选（apps/standalone/src/server.ts） ----------

const DIST_CANDS_CODE = arrayLiteral(SERVER_CODE, 'CLIENT_DIST_CANDIDATES')

test('SPA 根候选包含打包态路径（HERE/../client）：缺了它打包态必然回退仓库', () => {
  assert.match(
    DIST_CANDS_CODE,
    /path\.join\(\s*HERE\s*,\s*'\.\.'\s*,\s*'client'\s*\)/,
    `SPA 根候选缺少 path.join(HERE, '..', 'client')；实际：${DIST_CANDS_CODE}`,
  )
})

test('SPA 根候选包含源码态路径（HERE/../dist/client）与仓库回退', () => {
  assert.match(DIST_CANDS_CODE, /path\.join\(\s*HERE\s*,\s*'\.\.'\s*,\s*'dist'\s*,\s*'client'\s*\)/, DIST_CANDS_CODE)
  assert.match(DIST_CANDS_CODE, /path\.join\(\s*ROOT\s*,\s*'packages'\s*,\s*'client'\s*,\s*'dist'\s*\)/, DIST_CANDS_CODE)
})

test('SPA 根按存在性探测选择，且包内候选优先于仓库回退', () => {
  assert.match(SERVER_CODE, /CLIENT_DIST_CANDIDATES\.find\([^)]*existsSync/, '应逐个候选探测存在性，而不是固定取某个下标')
  const entries = [...DIST_CANDS_CODE.matchAll(/path\.join\(([^)]*)\)/g)].map(m => m[1])
  const pkgIdx = entries.findIndex(a => a.includes(`'..'`) && a.includes(`'client'`) && !a.includes(`'dist'`) && !a.includes(`'packages'`))
  const repoIdx = entries.findIndex(a => a.includes(`'packages'`))
  assert.ok(pkgIdx >= 0, `未找到打包态候选（HERE/../client）；实际条目：\n  ${entries.join('\n  ')}`)
  assert.ok(repoIdx >= 0, `未找到仓库回退候选；实际条目：\n  ${entries.join('\n  ')}`)
  assert.ok(pkgIdx < repoIdx, `包内候选必须排在仓库回退之前；实际 pkgIdx=${pkgIdx} repoIdx=${repoIdx}`)
})

// ---------- D8：进程级异常兜底 ----------

test('服务进程注册了 uncaughtException / unhandledRejection 兜底', () => {
  assert.match(SERVER_CODE, /process\.on\(\s*'uncaughtException'/, '缺少 uncaughtException 兜底 ⇒ 任何未捕获异常都会让服务进程退出')
  assert.match(SERVER_CODE, /process\.on\(\s*'unhandledRejection'/, '缺少 unhandledRejection 兜底 ⇒ 未处理的 Promise 拒绝会让服务进程退出')
})

test('兜底必须留痕（落盘 + stderr），不得静默吞异常', () => {
  assert.match(SERVER_CODE, /appendFileSync\(\s*(crashLogPath\(\)|file)\s*,/, '兜底必须把异常落盘，否则等于掩盖 bug')
  assert.match(SERVER_CODE, /console\.error\(/, '兜底必须同时打 stderr')
})
