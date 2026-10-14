// [git-discard-v1] 放弃更改的承重判据：已跟踪恢复 HEAD 内容 + 未跟踪被删除
// [WHY] gitDiscard 混跑两条 git 路径（restore --worktree / clean -f），任一分支写错即静默漏改
// [CONSTRAINT] 必须在临时 fixture 仓库跑——本动作会真实改工作区，绝不能在当前仓库执行
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const FIXTURE = path.join(process.cwd(), '.ai-runner/tmp/git-discard-fixture')

/** 在 fixture 目录里执行 git 并返回 stdout（测试自用，不经过被测模块） */
function gitIn(args: string[]): string {
  return execFileSync('git', args, {
    cwd: FIXTURE,
    encoding: 'utf8',
    env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
  }).trim()
}

/** 造一个只有一次提交的干净 fixture 仓库（含 base.txt） */
function setupFixture(): void {
  fs.rmSync(FIXTURE, { recursive: true, force: true })
  fs.mkdirSync(FIXTURE, { recursive: true })
  gitIn(['init', '-q'])
  gitIn(['config', 'user.email', 'fixture@example.com'])
  gitIn(['config', 'user.name', 'fixture'])
  fs.writeFileSync(path.join(FIXTURE, 'base.txt'), 'base\n', 'utf8')
  gitIn(['add', '-A'])
  gitIn(['commit', '-qm', 'base'])
}

test('gitDiscard: 已跟踪文件恢复到 HEAD 内容，未跟踪文件被删除', async () => {
  setupFixture()
  // 已跟踪：改成 dirty
  fs.writeFileSync(path.join(FIXTURE, 'base.txt'), 'dirty\n', 'utf8')
  // 未跟踪：新增文件
  fs.writeFileSync(path.join(FIXTURE, 'untracked.txt'), 'new\n', 'utf8')

  const { setRoot } = await import('../src/config.js')
  setRoot(FIXTURE)
  try {
    const { gitDiscard } = await import('../src/git.js')
    const r = await gitDiscard(['base.txt', 'untracked.txt'])
    assert.equal(r.ok, true, `gitDiscard 失败: ${r.reason || ''}`)
    // 已跟踪：内容回到 base
    assert.equal(fs.readFileSync(path.join(FIXTURE, 'base.txt'), 'utf8'), 'base\n', '已跟踪文件未恢复到 HEAD 内容')
    // 未跟踪：文件应被删除
    assert.equal(fs.existsSync(path.join(FIXTURE, 'untracked.txt')), false, '未跟踪文件未被删除')
    // 工作区应干净
    assert.equal(gitIn(['status', '--porcelain']), '', '放弃后工作区应干净')
  } finally {
    fs.rmSync(FIXTURE, { recursive: true, force: true })
  }
})

test('gitDiscard: 空数组幂等成功；非法路径（绝对 / ..）被过滤', async () => {
  const { setRoot } = await import('../src/config.js')
  setRoot(process.cwd())
  const { gitDiscard } = await import('../src/git.js')
  const r1 = await gitDiscard([])
  assert.equal(r1.ok, true, '空数组应成功')
  const r2 = await gitDiscard(['/etc/passwd', '../../etc/passwd'])
  assert.equal(r2.ok, true, '非法路径应被过滤后返回成功')
  assert.deepEqual(r2.discarded, [], '非法路径不应进入 discarded')
})
