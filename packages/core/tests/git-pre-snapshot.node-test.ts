// [git-first-rollback-v1] 运行前快照 ref（refs/ai-runner/pre/<runId>）的特性单测
// [WHY] /rollback 的内容来源由 .before 改为 git ref，须固化「tracked 与 untracked 都能逐文件取回」这一契约
// [CONSTRAINT] 必须在临时 fixture 仓库里跑——gitSnapshot 会写 ref，绝不能在当前仓库造 ref / 发 commit
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const FIXTURE = path.join(process.cwd(), '.ai-runner/tmp/git-pre-fixture')

/** 在 fixture 目录里执行 git 并返回 stdout（测试自用，不经过被测模块） */
function gitIn(args: string[]): string {
  return execFileSync('git', args, {
    cwd: FIXTURE,
    encoding: 'utf8',
    env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
  }).trim()
}

/** 造一个只有一次提交的干净 fixture 仓库 */
function setupFixture(): void {
  fs.rmSync(FIXTURE, { recursive: true, force: true })
  fs.mkdirSync(FIXTURE, { recursive: true })
  gitIn(['init', '-q'])
  gitIn(['config', 'user.email', 'fixture@example.com'])
  gitIn(['config', 'user.name', 'fixture'])
  fs.writeFileSync(path.join(FIXTURE, 'a.txt'), 'base\n', 'utf8')
  gitIn(['add', '-A'])
  gitIn(['commit', '-qm', 'base'])
}

test('gitSnapshot: 固化 refs/ai-runner/pre/<runId>，tracked 与 untracked 均可逐文件取回', async () => {
  setupFixture()
  const { setRoot } = await import('../../../packages/core/src/config.js')
  setRoot(FIXTURE)
  try {
    const { gitSnapshot, gitRestoreFile, gitDropRef } = await import('../../../packages/core/src/git.js')
    // 运行前：已跟踪文件被改 + 存在一个未跟踪文件（stash create 把后者放进第三父提交，单条 restore 取不回）
    fs.writeFileSync(path.join(FIXTURE, 'a.txt'), 'worktree-a\n', 'utf8')
    fs.writeFileSync(path.join(FIXTURE, 'untracked.txt'), 'u1\n', 'utf8')

    const snap = await gitSnapshot('fixture-run-1')
    assert.equal(snap.ok, true)
    assert.equal(snap.ref, 'refs/ai-runner/pre/fixture-run-1')
    const ref = snap.ref
    assert.ok(ref)
    assert.ok(gitIn(['rev-parse', '--verify', ref]).length > 0, 'ref 必须指向真实对象')

    // 模拟运行把两个文件都改掉
    fs.writeFileSync(path.join(FIXTURE, 'a.txt'), 'after-a\n', 'utf8')
    fs.writeFileSync(path.join(FIXTURE, 'untracked.txt'), 'u2\n', 'utf8')

    assert.equal((await gitRestoreFile(ref, 'a.txt')).ok, true)
    assert.equal(fs.readFileSync(path.join(FIXTURE, 'a.txt'), 'utf8'), 'worktree-a\n')
    assert.equal((await gitRestoreFile(ref, 'untracked.txt')).ok, true)
    assert.equal(fs.readFileSync(path.join(FIXTURE, 'untracked.txt'), 'utf8'), 'u1\n')
    // 只改工作区：已跟踪文件仍处于「相对 HEAD 已修改」的索引状态，未被 stage
    assert.equal(gitIn(['diff', '--cached', '--name-only']), '')

    await gitDropRef(ref)
    assert.equal(gitIn(['for-each-ref', '--format=%(refname)', 'refs/ai-runner/pre/']), '')
  } finally {
    setRoot(process.cwd())
    fs.rmSync(FIXTURE, { recursive: true, force: true })
  }
})

test('gitRestoreFile: 只认 refs/ai-runner/pre/，拒绝 ref 注入与路径穿越', async () => {
  setupFixture()
  const { setRoot } = await import('../../../packages/core/src/config.js')
  setRoot(FIXTURE)
  try {
    const { gitRestoreFile, gitDropRef } = await import('../../../packages/core/src/git.js')
    assert.equal((await gitRestoreFile('refs/heads/master', 'a.txt')).ok, false, '不得从任意分支恢复')
    assert.equal((await gitRestoreFile('refs/ai-runner/pre/x', '../outside.txt')).ok, false, '不得路径穿越')
    assert.equal((await gitRestoreFile('refs/ai-runner/pre/x', '/etc/hosts')).ok, false, '不得绝对路径')
    // 幂等：删不存在的 ref / 非本命名空间的 ref 都不抛错也不误删
    await gitDropRef('refs/ai-runner/pre/__none__')
    await gitDropRef('refs/heads/master')
    assert.ok(gitIn(['rev-parse', '--verify', 'refs/heads/master']).length > 0, 'master 必须还在')
  } finally {
    setRoot(process.cwd())
    fs.rmSync(FIXTURE, { recursive: true, force: true })
  }
})
