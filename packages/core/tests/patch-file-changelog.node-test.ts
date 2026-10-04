// [patch-skip-changelog-v1] AGENDA-4 回归守卫：patchFile 在 opts.marker 短路时必须补记 changelog。
//
// 背景（会议 AGENDA-2 复核结论）：`patchFile` 的 marker 短路是**幂等设计**，不是缺陷；
// 但它静默返回 `{ ok:true, skipped:true }` 而不写任何 changelog → 「这次 patch 到底跑了还是被跳过」
// 在审计链路上查不到。本测试钉住三件事：
//   ① marker 命中 → 文件**不得**被改动，且 changelog 出现 `patch-skip`；
//   ② marker 未命中 → 正常落盘，记 `patch`（不得误记 patch-skip）；
//   ③ 不传 marker → 正常落盘（AGENDA-2 已证的落盘语义不许动）。
//
// 每个用例在独立临时 cwd 下执行：`_changelog` 写入 `process.cwd()/.ai-runner/changelog.jsonl`，
// 换 cwd 即可零副作用地观测（不污染仓库真实 changelog，也不需要 mock）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, it } from 'vitest'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..', '..')
const HELPERS = path.join(ROOT, 'packages', 'core', 'src', 'helpers.cjs')

interface AiApi {
  patchFile: (
    file: string,
    anchor: string,
    replacement: string,
    opts?: { marker?: string },
  ) => { ok: boolean, skipped?: boolean, replaced?: number }
}
interface ChangelogRec {
  ts: number
  action: string
  file: string
}

const require = createRequire(import.meta.url)
let api: AiApi | null = null
function loadAI(): AiApi {
  if (!api) {
    require(HELPERS) // helpers.cjs 顶层执行 `global.__AI__ = __AI__`
    api = (globalThis as unknown as { __AI__?: AiApi }).__AI__ ?? null
  }
  assert.ok(api && typeof api.patchFile === 'function', 'helpers.cjs 未导出 __AI__.patchFile')
  return api
}

const CWD0 = process.cwd()
const tmpDirs: string[] = []
afterAll(() => {
  process.chdir(CWD0)
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
})
/** 在独立临时目录里执行 fn，结束后切回原 cwd（避免污染仓库 .ai-runner/changelog.jsonl） */
function inTmp(fn: (dir: string) => void): void {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), 'qgm-patch-skip-'))
  tmpDirs.push(created)
  process.chdir(created)
  // [symlink-cwd-v1] macOS 上 /tmp 是 /private/tmp 的符号链接，chdir 后 process.cwd() 返回 realpath；
  //   若拿 chdir 前的字符串拼目标文件路径，path.relative(cwd, file) 会算出 ../../../tmp/... 这种假相对路径。
  const dir = process.cwd()
  try {
    fn(dir)
  } finally {
    process.chdir(CWD0)
  }
}
function changelog(dir: string): ChangelogRec[] {
  const p = path.join(dir, '.ai-runner', 'changelog.jsonl')
  if (!fs.existsSync(p)) return []
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as ChangelogRec)
}

it('marker 命中：文件不被改动，且补记 patch-skip', () => {
  const AI = loadAI()
  inTmp((dir) => {
    const f = path.join(dir, 'target.cjs')
    const marker = '// [marked] 已打标'
    fs.writeFileSync(f, `${marker}\nconst V = 1\n`)
    const before = fs.readFileSync(f, 'utf8')

    const r = AI.patchFile(f, 'const V = 1', 'const V = 2', { marker })
    assert.equal(r.ok, true)
    assert.equal(r.skipped, true, 'marker 命中必须返回 skipped:true')
    assert.equal(fs.readFileSync(f, 'utf8'), before, 'marker 短路不得改动文件')

    const recs = changelog(dir)
    assert.deepEqual(recs.map(x => x.action), ['patch-skip'], 'marker 短路必须留下 patch-skip 记录')
    assert.equal(recs[0].file, 'target.cjs', '记录里应是相对 cwd 的路径')
  })
})

it('marker 未命中：正常落盘并记 patch（不得误记 patch-skip）', () => {
  const AI = loadAI()
  inTmp((dir) => {
    const f = path.join(dir, 'target.cjs')
    fs.writeFileSync(f, 'const V = 1\n')

    const r = AI.patchFile(f, 'const V = 1', 'const V = 2', { marker: '这段文字不存在' })
    assert.equal(r.ok, true)
    assert.equal(r.replaced, 1)
    assert.match(fs.readFileSync(f, 'utf8'), /const V = 2/, 'marker 未命中时应正常落盘')

    const recs = changelog(dir)
    assert.deepEqual(recs.map(x => x.action), ['patch'])
  })
})

it('不传 marker：正常落盘（AGENDA-2 的落盘语义未变）', () => {
  const AI = loadAI()
  inTmp((dir) => {
    const f = path.join(dir, 'target.cjs')
    fs.writeFileSync(f, 'const V = 1\n')

    const r = AI.patchFile(f, 'const V = 1', 'const V = 3', {})
    assert.equal(r.ok, true)
    assert.equal(r.replaced, 1)
    assert.match(fs.readFileSync(f, 'utf8'), /const V = 3/)
  })
})
