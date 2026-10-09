// @desc overlay 落盘与校验工具能力边界的守卫测试
// @why 应用端实跑踩到两个「看起来像错误、实为机制边界」的坑：① 沙箱内 writeText 只进 overlay，
//   子进程读真盘 ⇒ node --check 报 MODULE_NOT_FOUND；② syntaxCheck 恒按 CJS 编译，对 .ts 报
//   "Cannot use import statement outside a module"，把 AI 带偏去改本就正确的 import。
//   二者修复后若无承重判据，重构时会静默退化回「AI 反复重试」的老路。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const ROOT = process.cwd()
const req = createRequire(import.meta.url)
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')

/** 装载 helpers（会挂 globalThis.__AI__）；幂等 */
function loadAi(): any {
  req('../src/helpers/index.cjs')
  return (globalThis as unknown as { __AI__: any }).__AI__
}

test('① syntaxCheck：.ts 源码判为能力边界 UNSUPPORTED_LANG，并指路 lint/typeCheck', () => {
  const ai = loadAi()
  // [WHY] 必须用「TS 独有语法」而非 import：带 import 的 .ts 会被 ESM 错误分支兜住，
  //   那样摘掉扩展名判据测试仍绿 ⇒ 判据不承重。类型标注在 vm.Script 里报的是非 ESM 文案，
  //   只有扩展名判据能识别。
  const r = ai.syntaxCheck('interface Foo { a: number }\nconst x: number = 1\nexport default x\n', 'a.ts')
  assert.equal(r.ok, false, '.ts 不该被当成语法错通过')
  assert.equal(r.code, 'UNSUPPORTED_LANG', '非 CJS 必须归类为能力边界')
  assert.ok(/lint|typeCheck/.test(String(r.hint || '')), 'hint 必须指路到 lint / typeCheck')
})

test('② syntaxCheck：无扩展名的 ESM 源码同样判为能力边界（vm 报 import 不是语法错）', () => {
  const ai = loadAi()
  const r = ai.syntaxCheck('export const a = 1\n')
  assert.equal(r.code, 'UNSUPPORTED_LANG')
  const r2 = ai.syntaxCheck('import x from \'y\'\nconsole.log(x)\n')
  assert.equal(r2.code, 'UNSUPPORTED_LANG')
})

test('③ 反例：真正的 CJS 语法错仍按语法错返回（不得一律归为能力边界）', () => {
  const ai = loadAi()
  assert.equal(ai.syntaxCheck('const a = 1\n').ok, true, '合法 CJS 必须通过')
  const bad = ai.syntaxCheck('function ( {\n')
  assert.equal(bad.ok, false)
  assert.equal(bad.code, undefined, '真语法错不得标 UNSUPPORTED_LANG，否则 AI 会以为工具不支持')
})

test('④ overlay 盲区提示：仅「沙箱内 + 文件不可见类失败」才给 hint', () => {
  const { _overlayBlindHint } = req('../src/helpers/shell.cjs') as { _overlayBlindHint: (s: string) => string | null }
  const prev = process.env.AI_RUNNER_OVERLAY
  try {
    process.env.AI_RUNNER_OVERLAY = '/tmp/x-overlay.json'
    assert.ok(_overlayBlindHint('Error: Cannot find module \'/x/y.js\'\nMODULE_NOT_FOUND'), 'MODULE_NOT_FOUND 必须给 hint')
    assert.ok(_overlayBlindHint('ENOENT: no such file or directory'), 'ENOENT 必须给 hint')
    assert.equal(_overlayBlindHint('AssertionError: expected 1 to be 2'), null, '非文件类失败不得给 hint（否则每条失败都刷噪音）')
    process.env.AI_RUNNER_OVERLAY = ''
    assert.equal(_overlayBlindHint('MODULE_NOT_FOUND'), null, '非沙箱上下文（裸 node）不得给 hint')
  } finally {
    if (prev === undefined) delete process.env.AI_RUNNER_OVERLAY
    else process.env.AI_RUNNER_OVERLAY = prev
  }
})

test('⑤ 接线锚点：flush 三段（interceptor 原语 / __AI__ 转发 / shell 失败注入）', () => {
  const ic = read('packages/core/src/interceptor.cjs')
  assert.ok(ic.includes('globalThis.__AI_APPLY_OVERLAY = applyNow'), 'interceptor 必须暴露落盘原语')
  assert.ok(/PROBE_ROOT_RE\.test\(rel\)/.test(ic), '落盘规则须与服务端 applyOverlay 对齐（根级 .ai-* 重定向）')
  // [helpers-misc-v1] flush 实现已迁出到 helpers/misc.cjs；index.cjs 只留薄壳转发。
  const idx = read('packages/core/src/helpers/index.cjs')
  assert.ok(/flush\(\) \{ return miscApi\.flush\(\) \}/.test(idx), '__AI__ 必须暴露 flush()（转发到 miscApi）')
  const misc = read('packages/core/src/helpers/misc.cjs')
  assert.ok(misc.includes('globalThis.__AI_APPLY_OVERLAY'), 'flush 必须转发到 interceptor 原语')
  const sh = read('packages/core/src/helpers/shell.cjs')
  assert.ok(/const hint = code === 0 \? null : _overlayBlindHint/.test(sh), '前台失败必须注入 overlay 提示')
})

test('⑥ 端到端：沙箱内 writeText → flush → 子进程能校验（真盘写入必须落盘）', () => {
  // [WHY] 假 fd 陷阱只在这个层面可见：沙箱把 fs.openSync 换成内存假 fd，而 Node 的
  //   writeFileSync 内部正是 openSync+writeSync+closeSync ⇒ 用 writeFileSync 落盘会静默失败
  //   （applied 计数照涨、真盘无文件），纯单测在裸 node 下永远复现不了。
  const probe = path.join(ROOT, '.ai-runner/tmp/e2e-flush-probe.cjs')
  const target = path.join(ROOT, '.ai-runner/tmp/e2e-flush-target.js')
  fs.mkdirSync(path.dirname(probe), { recursive: true })
  try { fs.unlinkSync(target) } catch { /* 首次运行无此文件 */ }
  fs.writeFileSync(probe, [
    'const path = require(\'node:path\')',
    ';(async () => {',
    '  const ai = globalThis.__AI__',
    '  const p = path.join(process.cwd(), \'.ai-runner\', \'tmp\', \'e2e-flush-target.js\')',
    '  ai.writeText(p, \'const a = 1\\nconsole.log(a)\\n\')',
    '  const before = await ai.shell([\'node\', \'--check\', p])',
    '  const fl = ai.flush()',
    '  const after = await ai.shell([\'node\', \'--check\', p])',
    '  console.log(JSON.stringify({ beforeOk: before.ok, hint: Boolean(before.hint), applied: fl.applied, afterOk: after.ok }))',
    '})()',
    '',
  ].join('\n'))
  const r = spawnSync(process.execPath, ['-r', './packages/core/src/interceptor.cjs', '-r', './packages/core/src/helpers.cjs', probe], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: '/tmp', AI_RUNNER_OVERLAY: path.join(ROOT, '.ai-runner/tmp/e2e-ov.json') },
  })
  const line = String(r.stdout || '').trim().split('\n').filter(l => l.startsWith('{')).pop()
  assert.ok(line, `探针未产出 JSON（stderr: ${String(r.stderr || '').slice(0, 200)}）`)
  const o = JSON.parse(line) as { beforeOk: boolean, hint: boolean, applied: number, afterOk: boolean }
  assert.equal(o.beforeOk, false, 'flush 前子进程应看不到 overlay 里的文件（否则说明问题不存在，本用例无意义）')
  assert.equal(o.hint, true, '失败结果必须带 hint，否则 AI 不知道为什么')
  assert.ok(o.applied >= 1, 'flush 至少应落盘 1 个文件')
  assert.equal(o.afterOk, true, 'flush 后子进程必须能校验该文件 —— 落盘必须进真盘')
})

test('⑦ 锚点：applyNow 必须用 openSync/writeSync/closeSync 三件套落盘', () => {
  const ic = read('packages/core/src/interceptor.cjs')
  assert.ok(/const fd = orig\.openSync\(dst, 'w'\)/.test(ic), '必须用 orig.openSync 拿真 fd')
  assert.ok(/orig\.writeSync\(fd, v\.data\)/.test(ic), '必须用 orig.writeSync 真写')
  assert.ok(!/orig\.writeFileSync\(dst, v\.data\)/.test(ic), '不得用 writeFileSync 落盘（会被假 fd 劫持）')
})

test('⑧ 教学锚点：SYSTEM.md 必须写明 flush 与 UNSUPPORTED_LANG', () => {
  const sys = read('packages/core/SYSTEM.md')
  assert.ok(sys.includes('flush()'), 'SYSTEM.md 必须教 flush（否则 AI 只能靠「先 exit 0 再开一轮」绕）')
  assert.ok(sys.includes('UNSUPPORTED_LANG'), 'SYSTEM.md 必须写明 syntaxCheck 的能力边界')
  assert.ok(sys.includes('lint([file])'), 'SYSTEM.md 必须给出 TS/Vue 的正确校验手段')
})
