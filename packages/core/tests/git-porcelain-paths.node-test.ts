// [porcelain-slice-v1] git status --porcelain 解析的回归守卫
// [WHY] 旧实现先 l.trim() 再 replace(/^.{3}/)：' M path' trim 后变 'M path'，再切 3 字符把路径首字符吞掉
//   → git add 报 pathspec 'ai-runner/lessons.md' did not match（实测于 /__ai/git/commit-loop）
// [CONSTRAINT] 必须在临时 fixture 仓库里跑——gitCommitAll 会写 ai-archive ref，绝不能在当前仓库造 commit
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const FIXTURE = path.join(process.cwd(), '.ai-runner/tmp/git-porcelain-fixture')

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
  fs.writeFileSync(path.join(FIXTURE, 'base.txt'), 'base\n', 'utf8')
  gitIn(['add', '-A'])
  gitIn(['commit', '-qm', 'base'])
}

test('gitCommitAll: 状态行以空格开头的路径不被吞字符（ai-runner/lessons.md 场景）', async () => {
  setupFixture()
  // 造一个「首字符会被旧解析吞掉」的路径：目录名 ai-runner，文件名 lessons.md
  fs.mkdirSync(path.join(FIXTURE, 'ai-runner'), { recursive: true })
  fs.writeFileSync(path.join(FIXTURE, 'ai-runner', 'lessons.md'), 'x\n', 'utf8')
  gitIn(['add', '-A'])
  gitIn(['commit', '-qm', 'add runner dir'])
  // 制造 ' M ai-runner/lessons.md'（首列空格 = 未暂存修改）
  fs.writeFileSync(path.join(FIXTURE, 'ai-runner', 'lessons.md'), 'changed\n', 'utf8')

  const { setRoot } = await import('../../../packages/core/src/config.js')
  setRoot(FIXTURE)
  try {
    const { gitCommitAll } = await import('../../../packages/core/src/git.js')
    const r = await gitCommitAll('fixture: porcelain path test')
    assert.equal(r.ok, true, `gitCommitAll 失败: ${r.reason || ''}`)
    assert.ok(r.commit, '应返回 commit sha')
    // 存档确实进 ai-archive，且路径完整
    const files = gitIn(['show', '--name-only', '--pretty=format:', r.commit!])
    assert.ok(files.includes('ai-runner/lessons.md'), `存档内容缺 ai-runner/lessons.md，实际: ${files}`)
  } finally {
    fs.rmSync(FIXTURE, { recursive: true, force: true })
  }
})

test('gitCommitAll: 工作区干净返回 empty 而非报错', async () => {
  setupFixture()
  const { setRoot } = await import('../../../packages/core/src/config.js')
  setRoot(FIXTURE)
  try {
    const { gitCommitAll } = await import('../../../packages/core/src/git.js')
    const r = await gitCommitAll('fixture: empty')
    assert.equal(r.ok, true)
    assert.equal(r.empty, true)
  } finally {
    fs.rmSync(FIXTURE, { recursive: true, force: true })
  }
})
