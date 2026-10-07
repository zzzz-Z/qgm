import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
// [crossfile-guard-v1] WO-20261007-10 段四：spawn 真守卫读 exit code，不经内部函数。
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..')
const GUARD = path.join(REPO, 'scripts', 'verify-crossfile.cjs')
const N = String.fromCharCode(10)

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'crossfile-'))
}
function write(root: string, rel: string, body: string): void {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body, 'utf8')
}
function run(root: string): { code: number | null, out: string, err: string } {
  const r = spawnSync('node', [GUARD, '--root', root], { encoding: 'utf8' })
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' }
}
function cleanup(root: string): void {
  fs.rmSync(root, { recursive: true, force: true })
}

test('G1 两文件自我声明同一编号 ⇒ exit 2，stderr 含编号与两文件名', () => {
  const root = makeRoot()
  try {
    write(root, 'docs/a-2026-10-07.md', `# WO-20261007-01${N}${N}正文`)
    write(root, 'docs/b-2026-10-07.md', `# WO-20261007-01${N}${N}正文`)
    const r = run(root)
    assert.equal(r.code, 2, `应 exit 2，实得 ${r.code}；err=${r.err}`)
    assert.ok(r.err.includes('WO-20261007-01'), 'stderr 须含冲突编号')
    assert.ok(r.err.includes('a-2026-10-07.md') && r.err.includes('b-2026-10-07.md'), 'stderr 须含两文件名')
  } finally { cleanup(root) }
})

test('G1 变异：改唯一 ⇒ exit 0', () => {
  const root = makeRoot()
  try {
    write(root, 'docs/a-2026-10-07.md', `# WO-20261007-01${N}${N}正文`)
    write(root, 'docs/b-2026-10-07.md', `# WO-20261007-02${N}${N}正文`)
    assert.equal(run(root).code, 0)
  } finally { cleanup(root) }
})

test('G2 正文交叉引用不算自我声明 ⇒ exit 0', () => {
  const root = makeRoot()
  try {
    write(root, 'docs/a-2026-10-07.md', `# 标题${N}${N}见 WO-20261007-01 的说明`)
    assert.equal(run(root).code, 0)
  } finally { cleanup(root) }
})

test('G2 变异：引用挪到首行 ⇒ exit 2', () => {
  const root = makeRoot()
  try {
    write(root, 'docs/a-2026-10-07.md', `# 标题${N}${N}正文`)
    write(root, 'docs/b-2026-10-07.md', `WO-20261007-01${N}${N}正文`)
    write(root, 'docs/c-2026-10-07.md', `# WO-20261007-01${N}${N}正文`)
    assert.equal(run(root).code, 2)
  } finally { cleanup(root) }
})

test('G3 悬空链接 ](no/such/file.md) ⇒ exit 2，stderr 给 文件 -> 目标', () => {
  const root = makeRoot()
  try {
    write(root, 'docs/a.md', `# 标题${N}${N}[x](no/such/file.md)`)
    const r = run(root)
    assert.equal(r.code, 2)
    assert.ok(r.err.includes('a.md -> no/such/file.md'), `stderr 须给位置：${r.err}`)
  } finally { cleanup(root) }
})

test('G3 变异：建出目标 ⇒ exit 0', () => {
  const root = makeRoot()
  try {
    write(root, 'docs/a.md', `# 标题${N}${N}[x](no/such/file.md)`)
    write(root, 'docs/no/such/file.md', '# 目标')
    assert.equal(run(root).code, 0)
  } finally { cleanup(root) }
})

test('G4 javascript: 伪链接被 skip ⇒ exit 0', () => {
  const root = makeRoot()
  try {
    write(root, 'docs/a.md', `# 标题${N}${N}[x](javascript:void(0))`)
    assert.equal(run(root).code, 0)
  } finally { cleanup(root) }
})

test('G5 父级相对路径 ../x.md 指向存在文件 ⇒ exit 0（基准是文件 dirname）', () => {
  const root = makeRoot()
  try {
    write(root, 'docs/sub/a.md', `# 标题${N}${N}[x](../x.md)`)
    write(root, 'docs/x.md', '# 目标')
    assert.equal(run(root).code, 0)
  } finally { cleanup(root) }
})

test('G7 围栏代码块内的假链接被豁免 ⇒ exit 0', () => {
  const root = makeRoot()
  try {
    write(root, 'docs/a.md', `# 标题${N}${N}\`\`\`${N}[x](no/such.md)${N}\`\`\``)
    assert.equal(run(root).code, 0)
  } finally { cleanup(root) }
})

// [crossfile-g8-v1] WO-20261007-11 指出：G1-G7 全 spawnSync 起新进程，
//   「禁模块顶层缓存」这条无任何变异能使它变红（新进程每次现读，缓存与否不可分辨）。
//   承重必须同进程两次读不同 root —— 这里用 createRequire 动态加载同一模块实例。
test('G8 同进程两次读不同 root：各自结果独立（禁顶层缓存承重）', async () => {
  const { createRequire } = await import('node:module')
  const req = createRequire(import.meta.url)
  const { runCrossfile } = req(GUARD) as { runCrossfile: (root: string) => { failures: string[], declaredCount: number, fileCount: number } }
  const rootA = makeRoot()
  const rootB = makeRoot()
  try {
    // A：冲突编号 ⇒ failures 非空
    write(rootA, 'docs/a-2026-10-07.md', `# WO-20261007-01${N}${N}正文`)
    write(rootA, 'docs/b-2026-10-07.md', `# WO-20261007-01${N}${N}正文`)
    // B：唯一编号 ⇒ failures 空
    write(rootB, 'docs/c-2026-10-07.md', `# WO-20261007-99${N}${N}正文`)
    const rA = runCrossfile(rootA)
    const rB = runCrossfile(rootB)
    assert.ok(rA.failures.length >= 1, `A 应失败：${JSON.stringify(rA.failures)}`)
    assert.equal(rB.failures.length, 0, `B 应通过，若为 ${rB.failures.length} 条说明 root 被缓存：${JSON.stringify(rB.failures)}`)
    // 反序再来一次，证明不是「第一次调用的结果」被留用
    const rB2 = runCrossfile(rootB)
    const rA2 = runCrossfile(rootA)
    assert.equal(rB2.failures.length, 0)
    assert.ok(rA2.failures.length >= 1)
  } finally { cleanup(rootA); cleanup(rootB) }
})
test('G6 真仓库 pnpm crossfile:verify ⇒ exit 0（ratchet 起点）', () => {
  const r = spawnSync('node', [GUARD], { encoding: 'utf8', cwd: REPO })
  assert.equal(r.status, 0, `真仓库应 exit 0：${r.stderr || ''}`)
})
