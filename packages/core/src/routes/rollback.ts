// [arch-hono/rollback-v1] /rollback + /rollback-all + /save 路由 Hono 版（fetch handler）
// [git-first-rollback-v1] 内容来源二选一：manifest.gitRef 存在则走 git（有 git 的项目），
//   否则回落 .before 内容副本（无 git / 快照失败）——与「git 优先，runner 兜底」同一条规则。
import { Hono } from 'hono'
import fs from 'node:fs'
import path from 'node:path'
import { getRoot } from '../config.js'
import { gitDropRef, gitRestoreFile } from '../git.js'
import { readManifest, runDir } from '../state/snapshot.js'

/** rollback 路由的 Hono 实例 */
export const rollbackHono = new Hono()

/**
 * 把一个文件还原到本次运行前的状态
 * [WHY] git 路径逐文件 restore 只改工作区、不动索引，比整次 reset 精确
 * [CONSTRAINT] added 类型没有历史内容 → 直接删除；git 失败必须有 .before 兜底，否则如实报错
 * @param dir 本次运行的快照目录（.before 的读取根）
 * @param gitRef 运行前快照 ref；缺失即表示本次运行没有 git 兜底
 * @param changePath 相对仓库根的文件路径（取自 manifest，不接受客户端直传，避免路径穿越）
 * @param changeType 变更类型：added 直接删除，其余按内容还原
 * @returns 成功返回 null；失败返回给客户端的错误文案
 */
async function restoreOne(
  dir: string,
  gitRef: string | undefined,
  changePath: string,
  changeType: string,
): Promise<string | null> {
  const target = path.join(getRoot(), changePath)
  if (changeType === 'added') {
    if (fs.existsSync(target)) fs.unlinkSync(target)
    return null
  }
  const viaGit = gitRef
    ? await gitRestoreFile(gitRef, changePath)
    : { ok: false, reason: '本次运行无 git 运行前快照' }
  if (viaGit.ok) return null
  const bak = path.join(dir, `${changePath}.before`)
  if (!fs.existsSync(bak)) return `快照文件缺失（git 恢复失败：${viaGit.reason}）`
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(bak, target)
  return null
}

rollbackHono.post('/rollback', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { runId?: string, file?: string } | null
  const { runId, file } = body || {}
  if (!runId || !file) return c.json({ error: '缺 runId 或 file' }, 400)
  const dir = runDir(String(runId))
  if (!fs.existsSync(dir)) return c.json({ error: '运行记录不存在' }, 404)
  const manifest = readManifest(String(runId))
  if (!manifest) return c.json({ error: '快照损坏' }, 500)
  const change = manifest.changes.find(x => x.path === file)
  if (!change) return c.json({ error: '该文件不在本次改动中' }, 400)
  const failed = await restoreOne(dir, manifest.gitRef, change.path, change.type)
  if (failed) return c.json({ error: failed }, 500)
  return c.json({ ok: true, file: change.path, type: change.type })
})

rollbackHono.post('/rollback-all', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { runId?: string } | null
  const runId = body?.runId
  if (!runId) return c.json({ error: '缺 runId' }, 400)
  const dir = runDir(String(runId))
  if (!fs.existsSync(dir)) return c.json({ error: '运行记录不存在' }, 404)
  const manifest = readManifest(String(runId))
  if (!manifest) return c.json({ error: '快照损坏' }, 500)
  let n = 0
  for (const ch of manifest.changes) {
    // 逐文件失败不中断整次回滚：其余文件继续尝试，计数只统计真正还原成功的
    const failed = await restoreOne(dir, manifest.gitRef, ch.path, ch.type)
    if (!failed) n++
  }
  // 回滚完成后运行前 ref 已无用；不删会让 refs/ 随运行数累积
  await gitDropRef(manifest.gitRef || '')
  fs.rmSync(dir, { recursive: true, force: true })
  return c.json({ ok: true, count: n })
})

rollbackHono.post('/save', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { runId?: string } | null
  const runId = body?.runId
  if (!runId) return c.json({ error: '缺 runId' }, 400)
  const dir = runDir(String(runId))
  // 用户确认改动 → 运行前 ref 与快照目录一起回收
  const manifest = readManifest(String(runId))
  await gitDropRef(manifest?.gitRef || '')
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  return c.json({ ok: true })
})
