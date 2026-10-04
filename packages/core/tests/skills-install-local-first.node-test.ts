// [skills-install-v1] 回归守卫：安装必须**本地优先**，且顺序由代码强制，不靠提示词自觉。
//
// 背景（2026-10-04 实测）：pnpm 技能 21 个文件其实已在 11:36 完整落盘，但那次 /run 报
// `exit:-1 / 66.2s`（撞 /run 的 60s 硬超时 + 5s 宽限）→ AI 只读退出码 → 判定失败 →
// 不更新 registry → 下次查表「pnpm 不在」→ 重新联网安装 → 再撞超时。磁盘 15 / 表 14 缺的正是 pnpm。
// 修复的关键不是「把文档写清楚」，而是**把顺序焊进代码**：前两层命中时 network 恒为 0，
// AI 在结构上无从「跳过本地直接联网」。
//
// 本测试钉住四件事（全部离线，夹具仓库刻意不存在，一旦误走联网就会立刻失败）：
//   ① 本地已装 → already-installed 且 network === 0；
//   ② 本地库命中 → from-store 且 network === 0，文件被完整复制；
//   ③ force 只跳过第一层（仍会用本地库）—— 这是「三级短路」的边界，最容易被写错；
//   ④ 规格校验拒绝路径穿越与非法技能名（安装端点是新的外部输入面）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, it } from 'vitest'

import type { NormalizedSpec } from '../src/skills/installer.js'
import { installSkill, parseInstallSpec } from '../src/skills/installer.js'
import { loadRegistry, skillsDir, storeDir } from '../src/skills/registry.js'

const tmpDirs: string[] = []
function mkRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qgm-skills-install-'))
  tmpDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
})

const OWNER = 'qgm-no-such-org'
const REPO = 'qgm-no-such-repo'
const SKILL = 'demo-skill'
const SKILL_MD = `---\nname: ${SKILL}\ndescription: 本地优先安装的测试夹具技能\n---\n\n正文\n`

/** 基座规格：owner/repo 刻意不存在 —— 任何误走联网的路径都会立刻失败而不是静默通过 */
function baseSpec(over: Partial<NormalizedSpec> = {}): NormalizedSpec {
  return { owner: OWNER, repo: REPO, ref: 'HEAD', dir: `skills/${SKILL}`, skill: SKILL, force: false, refresh: false, ...over }
}

/** 造一份可用的技能目录（含一个 references 子目录，用于验证递归复制） */
function putSkillDir(dir: string): void {
  fs.mkdirSync(path.join(dir, 'references'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), SKILL_MD)
  fs.writeFileSync(path.join(dir, 'references', 'a.md'), 'ref-a\n')
}

function targetDir(root: string): string {
  return path.join(skillsDir(root), SKILL)
}
function localStoreDir(root: string): string {
  return path.join(storeDir(root), OWNER, REPO, SKILL)
}

it('本地已装 → already-installed，且完全不联网（network === 0）', async () => {
  const root = mkRoot()
  putSkillDir(targetDir(root))

  const r = await installSkill(root, baseSpec())

  assert.equal(r.ok, true)
  assert.equal(r.status, 'already-installed', '本地已装必须短路在第一层')
  assert.equal(r.network, 0, '本地优先：命中已装时不得发起任何远端请求')
  assert.deepEqual(r.files, [])
})

it('本地库命中 → from-store，文件完整复制，仍不联网', async () => {
  const root = mkRoot()
  putSkillDir(localStoreDir(root))

  const r = await installSkill(root, baseSpec())

  assert.equal(r.ok, true)
  assert.equal(r.status, 'from-store', '第二层应命中本地库')
  assert.equal(r.network, 0, '本地库命中时不得发起任何远端请求')
  assert.deepEqual(r.files.slice().sort(), ['SKILL.md', 'references/a.md'])
  assert.equal(fs.readFileSync(path.join(targetDir(root), 'SKILL.md'), 'utf8'), SKILL_MD)
  assert.equal(fs.readFileSync(path.join(targetDir(root), 'references', 'a.md'), 'utf8'), 'ref-a\n')
})

it('force 只跳过「已装」这一层，仍吃本地库（三级短路的边界）', async () => {
  const root = mkRoot()
  putSkillDir(targetDir(root))
  putSkillDir(localStoreDir(root))

  const r = await installSkill(root, baseSpec({ force: true }))

  assert.equal(r.ok, true)
  assert.equal(r.status, 'from-store', 'force 的语义是「忽略已装、重装」，不应直接跳到联网')
  assert.equal(r.network, 0)
})

it('安装成功后 registry 收敛到磁盘（含该技能，来源为 owner/repo）', async () => {
  const root = mkRoot()
  putSkillDir(localStoreDir(root))

  const r = await installSkill(root, baseSpec())

  assert.equal(r.ok, true)
  const names = loadRegistry(root).entries.map(e => e.name)
  assert.deepEqual(names, [SKILL], 'registry 必须与磁盘恒等，否则又会退化成假阴性')
  assert.equal(r.registry?.added.includes(SKILL), true)
})

it('规格校验：拒绝非法输入（外部输入面不许有默认值兜底）', () => {
  const bad = [
    {},
    { source: 'no-slash', skill: SKILL },
    { source: `${OWNER}/${REPO}` },
    { source: `${OWNER}/${REPO}`, skill: 'Bad_Name' },
    { source: `${OWNER}/${REPO}`, skill: '-leading' },
    { source: `${OWNER}/${REPO}`, skill: SKILL, path: 'skills/../../etc' },
    { source: `${OWNER}/${REPO}`, skill: SKILL, path: 'a/../b' },
    { source: `${OWNER}/${REPO}`, skill: SKILL, path: '..' },
    { source: `${OWNER}/${REPO}`, skill: SKILL, ref: '../main' },
  ]
  for (const body of bad) {
    const parsed = parseInstallSpec(body)
    assert.equal(parsed.ok, false, `应拒绝：${JSON.stringify(body)}`)
  }

  const good = parseInstallSpec({ source: `${OWNER}/${REPO}`, skill: SKILL })
  assert.equal(good.ok, true)
  assert.equal(good.ok && good.spec.dir, `skills/${SKILL}`, 'path 缺省应为 skills/<skill>')
  assert.equal(good.ok && good.spec.ref, 'HEAD')
  assert.equal(good.ok && good.spec.force, false)
  assert.equal(good.ok && good.spec.refresh, false)
})
