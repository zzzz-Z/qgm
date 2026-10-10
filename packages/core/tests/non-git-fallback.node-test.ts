// [non-git-fallback-v1] 「仓库不是 git」时核心链路是否仍然完整（SVN / 纯目录 / git 不可用）
// [WHY] 全仓的「运行前内容」有**两条**来源：git ref 优先，`.before` 内容副本兜底
//   （[git-first-rollback-v1]）。有 git 时 `.before` **刻意不落**，于是这条兜底路径在
//   日常回归里**永远走不到**——它坏掉也不会有人发现，直到有人换 SVN 或 git 不可用。
//   本文件把「无 .git」这一支钉成判据：变更预览（/files/before）、单文件回滚、整轮回滚
//   全部必须仍然可用，且真的能还原磁盘内容。
// [CONSTRAINT] 用真实 route handler（filesHono / rollbackHono）+ 真实磁盘，不是 mock——
//   这条链路的全部价值就在「真的把文件改回去」，mock 掉 fs 等于什么都没验。
import { afterAll, beforeAll, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Change } from '../src/config.js'

// 非 git 工作副本：临时目录，且其祖先目录都没有 .git（os.tmpdir 满足）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'non-git-probe-'))
afterAll(() => { fs.rmSync(TMP, { recursive: true, force: true }) })

interface HonoLike {
  request: (p: string, i: RequestInit) => Response | Promise<Response>
}

/** 走真实路由；Hono 的 request 既可同步返回也可返回 Promise，统一 await */
function post(hono: HonoLike, p: string, body: unknown): Promise<Response> {
  return Promise.resolve(hono.request(p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

function w(rel: string, s: string): void {
  const f = path.join(TMP, rel)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, s, 'utf8')
}

let snap: typeof import('../src/state/snapshot.js')
let gitRunner: typeof import('../src/git-runner.js')
let gitMod: typeof import('../src/git.js')
let filesHono: HonoLike
let rollbackHono: HonoLike

beforeAll(async () => {
  const cfg = await import('../src/config.js')
  // 先 setRoot 再 import 其余模块：snapshot / file-index 的路径都在调用时取 getRoot()
  cfg.setRoot(TMP)
  snap = await import('../src/state/snapshot.js')
  gitRunner = await import('../src/git-runner.js')
  gitMod = await import('../src/git.js')
  filesHono = (await import('../src/routes/files.js')).filesHono as unknown as HonoLike
  rollbackHono = (await import('../src/routes/rollback.js')).rollbackHono as unknown as HonoLike
})

test('[判定] 非 git 工作副本 ⇒ gitAvailable()=false', async () => {
  assert.equal(fs.existsSync(path.join(TMP, '.git')), false, '测试目录不该有 .git')
  assert.equal(await gitRunner.gitAvailable(), false)
  assert.equal(await gitRunner.gitAvailable(), false, '二次调用走缓存，仍须 false')
})

test('[快照] 无 gitRef ⇒ 落 .before 内容副本（added 不落）', async () => {
  w('src/a.ts', 'OLD-A\n')
  w('src/gone.ts', 'OLD-GONE\n')
  const before = new Map<string, string>([['src/a.ts', 'OLD-A\n'], ['src/gone.ts', 'OLD-GONE\n']])
  const changes: Change[] = [
    { path: 'src/a.ts', type: 'modified' },
    { path: 'src/gone.ts', type: 'deleted' },
    { path: 'src/new.ts', type: 'added' },
  ]

  // 模拟一次运行把盘改了
  w('src/a.ts', 'NEW-A\n')
  fs.unlinkSync(path.join(TMP, 'src/gone.ts'))
  w('src/new.ts', 'NEW-FILE\n')

  snap.saveSnapshot('R1', before, changes)

  const dir = snap.runDir('R1')
  assert.equal(fs.readFileSync(path.join(dir, 'src/a.ts.before'), 'utf8'), 'OLD-A\n')
  assert.equal(fs.readFileSync(path.join(dir, 'src/gone.ts.before'), 'utf8'), 'OLD-GONE\n')
  assert.equal(fs.existsSync(path.join(dir, 'src/new.ts.before')), false, 'added 无历史内容，不该落副本')
  assert.equal(snap.readManifest('R1')?.gitRef, undefined, '本用例必须落在「无 gitRef」分支')
})

test('[预览] /files/before 返 exists:true ⇒ 变更弹窗能算出 diff', async () => {
  const res = await post(filesHono, '/files/before', { runId: 'R1', file: 'src/a.ts' })
  const j = await res.json() as { content: string, exists: boolean }
  assert.equal(j.exists, true, '非 git 下 before 缺失 ⇒ diff 会退化成「未找到变更前快照」')
  assert.equal(j.content, 'OLD-A\n')
})

test('[回滚] git 恢复必然失败 ⇒ /rollback 回落副本并真还原', async () => {
  const viaGit = await gitMod.gitRestoreFile('refs/ai-runner/pre/R1', 'src/a.ts')
  assert.equal(viaGit.ok, false, '非 git 仓库下 git 恢复不该成功')

  const res = await post(rollbackHono, '/rollback', { runId: 'R1', file: 'src/a.ts' })
  assert.equal(res.status, 200)
  assert.equal(fs.readFileSync(path.join(TMP, 'src/a.ts'), 'utf8'), 'OLD-A\n', 'modified 未还原')
})

test('[回滚] /rollback-all 还原全部 + 回收 run 目录', async () => {
  w('src/gone.ts', 'STILL-NEW\n')
  const res = await post(rollbackHono, '/rollback-all', { runId: 'R1' })
  const j = await res.json() as { ok: boolean, count: number }
  assert.equal(j.ok, true)
  assert.equal(fs.readFileSync(path.join(TMP, 'src/gone.ts'), 'utf8'), 'OLD-GONE\n', 'deleted 未还原')
  assert.equal(fs.existsSync(path.join(TMP, 'src/new.ts')), false, 'added 应被删除')
  assert.equal(fs.existsSync(snap.runDir('R1')), false, 'run 目录应被回收')
})
