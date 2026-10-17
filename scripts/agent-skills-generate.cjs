#!/usr/bin/env node
// @desc 技能双层同步器：源码位 skills/<name>/ → 运行位 .ai-runner/skills/<name>/
// @why AGENTS.md 的「技能目录双层约定」要求两处一致，但中间那个同步器曾被删掉，
//   导致 skills/pm-agent 与 skills/qa-agent 只存在于源码位、宿主 GET /__ai/skills 扫不到
//   （实测 match 端点返回 matches: []，@ 选择器也命中不了）。
//   [CONSTRAINT] 本文件是唯一写入路径，替代已删除的 pm-agent-generate.cjs / qa-agent-generate.cjs。
// [CONSTRAINT] 只做「复制」不生成内容：SSOT 是 skills/ 里的真实文件，本脚本不拼字符串造技能。
//   历史上生成器用内容块拼 SKILL.md，改一次要跑两次生成、两处必然漂移，这是它被删的原因。
// [CONSTRAINT] 幂等：逐文件比对内容，一致则不动（不更新时间戳，避免 git 脏）。
// [CHANGE-IMPACT] 被 pnpm skills:gen（写）与 skills-guard.node-test.ts（--check）调用。

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'skills')
const DST = path.join(ROOT, '.ai-runner', 'skills')

/** 递归列出目录下所有文件的相对路径（按字典序，保证输出稳定） */
function walk(dir, base = dir) {
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const name of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, name)
    if (fs.statSync(abs).isDirectory()) out.push(...walk(abs, base))
    else out.push(path.relative(base, abs))
  }
  return out
}

/** 读源码位技能清单（每个含 SKILL.md 的目录） */
function listSourceSkills() {
  if (!fs.existsSync(SRC)) return []
  return fs.readdirSync(SRC)
    .filter((n) => {
      const d = path.join(SRC, n)
      return fs.statSync(d).isDirectory() && fs.existsSync(path.join(d, 'SKILL.md'))
    })
    .sort()
}

/** 比较单个技能两处内容，返回 { same, files } */
function diffSkill(name) {
  const srcDir = path.join(SRC, name)
  const dstDir = path.join(DST, name)
  const srcFiles = walk(srcDir)
  const dstFiles = walk(dstDir)
  const missing = srcFiles.filter(f => !dstFiles.includes(f))
  const extra = dstFiles.filter(f => !srcFiles.includes(f))
  const changed = srcFiles.filter((f) => {
    if (!dstFiles.includes(f)) return false
    return fs.readFileSync(path.join(srcDir, f), 'utf8') !== fs.readFileSync(path.join(dstDir, f), 'utf8')
  })
  return { same: !missing.length && !extra.length && !changed.length, missing, extra, changed }
}

/** 复制单个技能到运行位 */
function copySkill(name) {
  const srcDir = path.join(SRC, name)
  const dstDir = path.join(DST, name)
  const d = diffSkill(name)
  if (d.same) return { name, action: 'skip' }
  // [CONSTRAINT] 先清掉目标里多出来的文件：源码位删了文件，运行位必须跟着删，
  //   否则 .ai-runner/skills 会残留孤儿文件，与源码位永久不一致。
  for (const f of d.extra) fs.rmSync(path.join(dstDir, f), { force: true })
  for (const f of walk(srcDir)) {
    const to = path.join(dstDir, f)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(path.join(srcDir, f), to)
  }
  return { name, action: 'sync', files: walk(srcDir).length }
}

function main() {
  const check = process.argv.includes('--check')
  const names = listSourceSkills()
  if (!names.length) {
    console.log('[skills-gen] skills/ 下没有技能，跳过')
    return 0
  }
  let drift = 0
  for (const name of names) {
    if (check) {
      const d = diffSkill(name)
      if (d.same) {
        console.log(`[skills-gen] ✓ ${name}`)
      } else {
        drift++
        console.log(`[skills-gen] ✗ ${name}: 缺 ${d.missing.length} / 多 ${d.extra.length} / 改 ${d.changed.length}`)
        for (const f of [...d.missing, ...d.changed].slice(0, 5)) console.log(`    - ${f}`)
      }
      continue
    }
    const r = copySkill(name)
    if (r.action === 'sync') {
      console.log(`[skills-gen] 已同步 ${name}（${r.files} 个文件）`)
    }
    else { console.log(`[skills-gen] ${name} 无变化`)
    }
  }
  if (check && drift) {
    console.error(`[skills-gen] ${drift} 个技能源码位与运行位不一致：跑 pnpm skills:gen 修复`)
    return 2
  }
  if (check) console.log(`[skills-gen] 全部一致（${names.length} 个技能）`)
  return 0
}

process.exit(main())
