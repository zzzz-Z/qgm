// [archive-branch-parity-v1] 守卫「ai-archive 分支名」两处硬编码的一致性：
//   packages/core/src/git.ts 的 ARCHIVE_BRANCH（运行后存档 / gitCommitAfter / gitCommitAll）
//   与 scripts/git-archive.mjs 的 DEFAULT_BRANCH（pnpm git:archive 批量兜底）是同一条
//   设计主线的两个落点，但分属 TS 源码与宿主脚本，无法共享常量（与 limit-marker-guard
//   的三处正则同构问题同一类）。改一处不改另一处 ⇒ 存档落进两个不同分支，
//   「git checkout ai-archive -- <path> 找回」的恢复路径静默失效。
//   静态断言（脚本不可 import，走源码字面量提取对比）。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()

function extractBranch(file: string, pattern: RegExp, label: string): string {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
  const m = src.match(pattern)
  assert.ok(m, `${label}（${file}）中找不到分支名字面量 —— 常量被改名/移位后必须同步本守卫`)
  return m[1]
}

test('git.ts 与 git-archive.mjs 的存档分支名一致', () => {
  const coreBranch = extractBranch(
    'packages/core/src/git.ts',
    /ARCHIVE_BRANCH = '([^']+)'/,
    'ARCHIVE_BRANCH',
  )
  const scriptBranch = extractBranch(
    'scripts/git-archive.mjs',
    /DEFAULT_BRANCH = '([^']+)'/,
    'DEFAULT_BRANCH',
  )
  assert.equal(coreBranch, scriptBranch, '两处存档分支名漂移：恢复文档（git checkout <分支> -- <path>）会指向不存在的分支')
})
