// [skills-registry-v2] 回归守卫：registry 必须与磁盘**恒等**，消灭「已装却在表里查不到」的假阴性。
//
// 背景（2026-10-04 实测）：旧设计把 `.registry.json` 当「已装清单」，由 AI 手工维护 → 与磁盘静默漂移
// （磁盘 15 个技能 / 表 14 条，缺 pnpm）→ AI 查表得假阴性「pnpm 没装」→ 重复联网安装 → 反复撞
// /run 的 60s 硬超时。修复后 disk 是唯一事实来源，registry 只是来源标注，且每次读路径顺手收敛。
//
// 本测试钉住四件事：
//   ① registry 名字集合 ≡ 磁盘上「含 SKILL.md 的技能目录」集合（增/删两侧都对齐）；
//   ② 集合无变化时**不落盘**（GET /skills 会走这条路径，不能让读操作持续产生写）；
//   ③ 已有条目的 source/url 不被改写（避免把可信来源降级成 (unknown)）；
//   ④ .store / .registry.json 等点开头条目不被误当成技能。
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, it } from 'vitest'

import { inferSource, listInstalledNames, loadRegistry, reconcileRegistry, registryFile, skillsDir, upsertEntry } from '../src/skills/registry.js'

const tmpDirs: string[] = []
function mkRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qgm-skills-reg-'))
  tmpDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
})

/** 造一个磁盘上的技能目录（可选带「来源」行 / SOURCE.md） */
function putSkill(root: string, name: string, opts: { source?: string } = {}): void {
  const dir = path.join(skillsDir(root), name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: 测试用技能，用于守卫生效验证\n---\n\n正文\n`)
  if (opts.source) {
    fs.writeFileSync(path.join(dir, 'SOURCE.md'), `# 来源\n\n来源: ${opts.source}\n`)
  }
}

function sha16(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16)
}

it('listInstalledNames：只认「含 SKILL.md 的普通目录」，跳过点开头条目', () => {
  const root = mkRoot()
  putSkill(root, 'alpha')
  fs.mkdirSync(path.join(skillsDir(root), 'no-skill-md'), { recursive: true }) // 无 SKILL.md
  fs.mkdirSync(path.join(skillsDir(root), '.store'), { recursive: true }) // 本地库，不是技能
  fs.writeFileSync(path.join(skillsDir(root), '.registry.json'), '{"entries":[]}')

  assert.deepEqual(listInstalledNames(root), ['alpha'])
})

it('收敛：磁盘有、表里没有 → 自动补录（这正是 pnpm 缺失的那类假阴性）', () => {
  const root = mkRoot()
  putSkill(root, 'pnpm', { source: 'antfu/skills' })
  putSkill(root, 'vue')

  const r = reconcileRegistry(root, listInstalledNames(root))

  assert.deepEqual(r.added, ['pnpm', 'vue'], '磁盘上而表里没有的必须被补录')
  assert.deepEqual(r.removed, [])
  assert.equal(r.total, 2)
  const reg = loadRegistry(root)
  assert.deepEqual(reg.entries.map(e => e.name), ['pnpm', 'vue'])
  assert.equal(reg.entries.find(e => e.name === 'pnpm')?.source, 'antfu/skills', '来源应从 SOURCE.md 推断')
  assert.equal(reg.entries.find(e => e.name === 'vue')?.source, '(unknown)', '推不出来就如实记 (unknown)')
})

it('收敛：表里有、磁盘已删 → 移除（集合两侧都对齐）', () => {
  const root = mkRoot()
  putSkill(root, 'keep')
  upsertEntry(root, { name: 'keep', source: 'antfu/skills', url: 'https://example.invalid/keep' })
  upsertEntry(root, { name: 'ghost', source: 'antfu/skills', url: 'https://example.invalid/ghost' })

  const r = reconcileRegistry(root, listInstalledNames(root))

  assert.deepEqual(r.removed, ['ghost'])
  assert.deepEqual(r.added, [])
  assert.deepEqual(loadRegistry(root).entries.map(e => e.name), ['keep'])
  assert.equal(
    loadRegistry(root).entries[0].source,
    'antfu/skills',
    '已有条目的 source 不得被 (unknown) 覆盖（那等于把可信来源降级）',
  )
})

it('收敛幂等：集合无变化时不落盘（GET /skills 走这条路径，读操作不该持续产生写）', () => {
  const root = mkRoot()
  putSkill(root, 'alpha')
  reconcileRegistry(root, listInstalledNames(root))
  const file = registryFile(root)
  const first = sha16(file)
  const mtime = fs.statSync(file).mtimeMs

  const again = reconcileRegistry(root, listInstalledNames(root))

  assert.deepEqual(again, { added: [], repaired: [], removed: [], total: 1 })
  assert.equal(sha16(file), first, '内容必须逐字节一致')
  assert.equal(fs.statSync(file).mtimeMs, mtime, '无变化时不得重写文件')
})

it('inferSource：只接受 owner/repo 形状，拒绝「像来源却不是来源」的值', () => {
  const root = mkRoot()
  // 真实反例：pnpm/SKILL.md 的 frontmatter 写着
  //   source: Generated from https://github.com/pnpm/pnpm, scripts located at https://github.com/antfu/skills
  // 宽松匹配会把来源写成 `Generated` —— 那是**错误数据**，比缺失更糟。
  putSkill(root, 'pnpm')
  fs.writeFileSync(
    path.join(skillsDir(root), 'pnpm', 'SKILL.md'),
    '---\nname: pnpm\ndescription: 测试用技能，用于守卫生效验证\nmetadata:\n  source: Generated from https://github.com/pnpm/pnpm\n---\n\n正文\n',
  )

  assert.equal(inferSource(root, 'pnpm'), '(unknown)', '推不出 owner/repo 就必须如实记 (unknown)')
})

it('收敛会修复脏来源（一次错误推断不得被永久保留）', () => {
  const root = mkRoot()
  putSkill(root, 'pnpm')
  fs.writeFileSync(
    path.join(skillsDir(root), 'pnpm', 'SKILL.md'),
    '---\nname: pnpm\ndescription: 测试用技能，用于守卫生效验证\nmetadata:\n  source: Generated from https://github.com/pnpm/pnpm\n---\n\n正文\n',
  )
  fs.mkdirSync(skillsDir(root), { recursive: true })
  fs.writeFileSync(registryFile(root), JSON.stringify({ entries: [{ name: 'pnpm', source: 'Generated', url: '(unknown)' }] }))

  const r = reconcileRegistry(root, listInstalledNames(root))

  assert.deepEqual(r.repaired, ['pnpm'], '不像来源的旧值应触发重推')
  assert.deepEqual(r.added, [], '已存在的条目不算新增（否则会被误读成「刚装上」）')
  assert.equal(loadRegistry(root).entries[0].source, '(unknown)')
})

it('inferSource：SOURCE.md 优先于 SKILL.md，且识别中英文标签', () => {
  const root = mkRoot()
  putSkill(root, 'with-note', { source: 'obra/superpowers' })
  fs.writeFileSync(
    path.join(skillsDir(root), 'with-note', 'SKILL.md'),
    '---\nname: with-note\ndescription: 测试用技能，用于守卫生效验证\n---\n\n来源: should-not-win\n',
  )
  putSkill(root, 'inline')
  fs.writeFileSync(
    path.join(skillsDir(root), 'inline', 'SKILL.md'),
    '---\nname: inline\ndescription: 测试用技能，用于守卫生效验证\n---\n\n> source: anthropics/skills\n',
  )

  assert.equal(inferSource(root, 'with-note'), 'obra/superpowers')
  assert.equal(inferSource(root, 'inline'), 'anthropics/skills')
  assert.equal(inferSource(root, 'missing'), '(unknown)')
})
