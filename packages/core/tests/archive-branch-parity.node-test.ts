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

// [archive-exclude-conditional-v1] 承重判据：paths 含 `.ai-runner/` 前缀项时不得叠加 `:(exclude).ai-runner`。
// [WHY] 具体文件如 `.ai-runner/lessons.md`（.gitignore 白名单）被 exclude 后 pathspec 空集 ⇒ git 报
//   `pathspec '.ai-runner/lessons.md' did not match any files` ⇒ 整条 archive 链路失败（用户可见 toast）。
// [CONSTRAINT] 静态断言代码结构；变异方式=删掉 hasRunnerPath 判定 / 回退单行 add ⇒ 本用例必红。
// [CHANGE-IMPACT] 改动 gitArchiveBranch 的 add 逻辑须同步本用例。
test('gitArchiveBranch 必须按 paths 决定是否叠加 exclude（防 pathspec 空集）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'packages/core/src/git.ts'), 'utf8')
  const at = src.indexOf('async function gitArchiveBranch')
  assert.notEqual(at, -1, '找不到 gitArchiveBranch')
  const next = src.indexOf('export async function gitHead', at)
  const body = src.slice(at, next === -1 ? src.length : next)
  assert.ok(
    body.includes('hasRunnerPath'),
    'gitArchiveBranch 缺 hasRunnerPath 判定：paths 含 .ai-runner/ 项时 exclude 会让 pathspec 空集（用户可见 toast）',
  )
  // [archive-branch-parity-v2] 断言从「钉死字面量」放宽为「钉死两条分支并存」：
  //   2026-10-09 实测该守卫因 [archive-force-add-v1] 给两条分支各加了 `-f` 而假红——
  //   中间 flag 是可增的（`-f`/`--ignore-errors`…），但「一条带 exclude、一条不带」的结构不能变。
  //   [CONSTRAINT] 两侧仍必须各出现一次：单行回退 / 删掉任一分支仍必红（变异已验证）。
  const addBranches = body.match(/\[[^\]]*'add'[^\]]*\.\.\.(?:paths|existingPaths)[^\]]*\]/g) || []
  assert.ok(
    addBranches.some(a => !a.includes(':(exclude)'))
    && addBranches.some(a => a.includes(':(exclude).ai-runner')),
    'addArgs 双分支写法缺失：必须「有 .ai-runner 前缀项 → 不加 exclude；否则 → 加 exclude」',
  )
})
