// [rundir-traversal-guard-v1] 守卫 runDir 的路径穿越防护：
//   runId 会从 HTTP body 直传（/rollback /rollback-all /save /diff-from-baseline），
//   裸 path.join 时 `../` 可逃出 runs/，叠加调用方的 rmSync(recursive) 变成任意目录删除。
//   2026-10-06 应用端全景报告第 1 条坐实后加固。值级测试（真调 runDir，判据承重：
//   若守卫被删，穿越用例会拿到 runs 外路径而非抛错 → 用例转红）。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import path from 'node:path'
import { runDir, runsDir } from '../src/state/snapshot.js'

const runsDirPath = runsDir()

test('正常 runId（内部生成格式）行为不变：落在 runs/ 内', () => {
  const dir = runDir('1791171390627-oekp')
  assert.equal(dir, path.join(runsDirPath, '1791171390627-oekp'))
})

test('`../evil` 经清洗后落回 runs/ 内（穿越被中和，而非原样放行）', () => {
  // '../evil' 清洗掉 '/' 后剩 '...evil' —— 是 runs/ 内合法目录名，语义上本就不越界
  const dir = runDir('../evil')
  assert.equal(dir, path.join(runsDirPath, '..evil'))
  assert.ok(dir.startsWith(`${runsDirPath}${path.sep}`), '穿越用例竟落在 runs/ 外')
})

test('`..` / `.` / 空串均被拒绝（不退化成 runs/ 本身）', () => {
  // '..' 与 '.' 全由合法字符组成，字符集清洗后仍有残值，必须靠 relative 校验兜住
  assert.throws(() => runDir('..'), /非法 runId/)
  assert.throws(() => runDir('.'), /非法 runId/)
  assert.throws(() => runDir(''), /非法 runId/)
})
