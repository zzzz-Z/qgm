// @desc 技能双层一致性守卫：skills/<name>/ 必须已同步到 .ai-runner/skills/<name>/ 且内容逐字节一致
// @why 2026-10-17 实测事故：skills/pm-agent 与 skills/qa-agent 只存在于源码位，运行位为空，
//   GET /__ai/skills 扫不到、POST /__ai/skills/match 返回 matches: []，@ 选择器也命中不了。
//   当时没有任何判据能发现这件事——技能「存在但不可用」是完全静默的。
// [CONSTRAINT] 只做单向校验（源码位 → 运行位）：运行位还有 30 多个从远端装的技能，
//   它们不在 skills/ 下是正常的，反向断言会把它们全判成脏数据。
// [CONSTRAINT] 判据独立实现，不复用 scripts/agent-skills-generate.cjs：
//   若复用同一份实现，生成器写坏了守卫也会跟着坏，等于没有判据。
import { describe, expect, test } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const SRC = path.join(ROOT, 'skills')
const DST = path.join(ROOT, '.ai-runner', 'skills')

/** 递归列出目录下所有文件的相对路径（字典序，保证输出稳定） */
function walk(dir: string, base = dir): string[] {
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  for (const name of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, name)
    if (fs.statSync(abs).isDirectory()) out.push(...walk(abs, base))
    else out.push(path.relative(base, abs))
  }
  return out
}

/** 源码位的技能目录（含 SKILL.md 才算） */
function sourceSkills(): string[] {
  if (!fs.existsSync(SRC)) return []
  return fs.readdirSync(SRC)
    .filter((n) => {
      const d = path.join(SRC, n)
      return fs.statSync(d).isDirectory() && fs.existsSync(path.join(d, 'SKILL.md'))
    })
    .sort()
}

describe('skills 双层一致性', () => {
  test('源码位至少有一个技能（目录被清空时不得假绿）', () => {
    // [WHY] 若 skills/ 整个被删，下面的循环会零次迭代、断言全过——那是典型的真空判据。
    expect(sourceSkills().length).toBeGreaterThan(0)
  })

  test('每个源码位技能都在运行位存在，且文件集合与内容逐字节一致', () => {
    const drift: string[] = []
    for (const name of sourceSkills()) {
      const srcDir = path.join(SRC, name)
      const dstDir = path.join(DST, name)
      if (!fs.existsSync(path.join(dstDir, 'SKILL.md'))) {
        drift.push(`${name}: 运行位缺 SKILL.md（宿主扫不到，@ 选择器与 match 均不命中）`)
        continue
      }
      const srcFiles = walk(srcDir)
      const dstFiles = walk(dstDir)
      for (const f of srcFiles) {
        if (!dstFiles.includes(f)) { drift.push(`${name}: 运行位缺 ${f}`); continue }
        const a = fs.readFileSync(path.join(srcDir, f), 'utf8')
        const b = fs.readFileSync(path.join(dstDir, f), 'utf8')
        if (a !== b) drift.push(`${name}: ${f} 内容不一致`)
      }
      for (const f of dstFiles) {
        if (!srcFiles.includes(f)) drift.push(`${name}: 运行位多出 ${f}（源码位已删，需同步清理）`)
      }
    }
    expect(drift, `跑 pnpm skills:gen 修复：\n${drift.join('\n')}`).toEqual([])
  })

  test('SKILL.md 的 frontmatter 必须同时有 name 与 description', () => {
    // [WHY] 宿主 GET /__ai/skills 靠这两个字段返回元数据；缺 description 的技能不会进 match 摘要。
    const bad: string[] = []
    for (const name of sourceSkills()) {
      const text = fs.readFileSync(path.join(SRC, name, 'SKILL.md'), 'utf8')
      const m = text.match(/^---\n([\s\S]*?)\n---/)
      if (!m) { bad.push(`${name}: 缺 frontmatter`); continue }
      if (!/^name:\s*\S/m.test(m[1])) bad.push(`${name}: 缺 name`)
      if (!/^description:\s*\S/m.test(m[1])) bad.push(`${name}: 缺 description`)
    }
    expect(bad, bad.join('\n')).toEqual([])
  })
})
