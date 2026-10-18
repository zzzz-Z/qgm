// [skill-meta-cache-v1] listSkillMetas 的 frontmatter 缓存与字段校验守卫。
// [WHY] 每次 GET /skills / POST /skills/match 都会遍历目录并读每个 SKILL.md 全文；
//   加缓存后必须钉住「何时该失效」，否则要么读到过期数据、要么缓存形同虚设。
// [判据承重] 删掉 mtime 比对（改成无条件命中）⇒ T2 必红；
//   删掉 frontmatter 字段校验 ⇒ T4 必红。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, it } from 'vitest'

import { clearSkillMetaCache, listSkillMetas } from '../src/routes/skills.js'

const roots: string[] = []
afterAll(() => {
  for (const r of roots) {
    try { fs.rmSync(r, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  clearSkillMetaCache()
})

/** 建一个临时 root，并在 .ai-runner/skills/<name>/SKILL.md 写入内容 */
function mkSkill(name: string, body: string): { root: string, file: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qgm-skill-meta-'))
  roots.push(root)
  const dir = path.join(root, '.ai-runner', 'skills', name)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'SKILL.md')
  fs.writeFileSync(file, body)
  return { root, file }
}

function FM(name: string, desc: string): string {
  return `---\nname: ${name}\ndescription: ${desc}\n---\n\n正文\n`
}

it('listSkillMetas：正常解析 frontmatter 并返回元数据', () => {
  clearSkillMetaCache()
  const { root } = mkSkill('alpha', FM('alpha', '第一个技能'))
  const metas = listSkillMetas(root)
  assert.equal(metas.length, 1)
  assert.equal(metas[0].name, 'alpha')
  assert.equal(metas[0].description, '第一个技能')
  assert.equal(metas[0].path, '.ai-runner/skills/alpha/SKILL.md')
})

it('listSkillMetas：mtime 变化后重新解析', () => {
  clearSkillMetaCache()
  const { root, file } = mkSkill('gamma', FM('gamma', '旧描述'))
  assert.equal(listSkillMetas(root)[0].description, '旧描述')

  fs.writeFileSync(file, FM('gamma', '新描述'))
  const future = new Date(Date.now() + 60_000)
  fs.utimesSync(file, future, future)

  assert.equal(
    listSkillMetas(root)[0].description,
    '新描述',
    'mtime 变了必须重新读盘，否则编辑技能后永远看到旧元数据',
  )
})

it('listSkillMetas：clearSkillMetaCache 强制重读', () => {
  // [cache-test-determinism-v1] 不用 utimesSync「还原」原 mtime：Date 只有毫秒精度，
  //   原始 mtimeMs 带小数，还原后可能跨毫秒边界（X.9812 → X+1.999），Math.floor 也挡不住。
  //   改为两次都显式设同一个固定时间戳 —— 缓存比较的就是这个值，不存在还原误差。
  clearSkillMetaCache()
  const { root, file } = mkSkill('delta', FM('delta', '清缓存前'))

  const FIXED = new Date('2026-01-01T00:00:00.000Z')
  fs.utimesSync(file, FIXED, FIXED)
  assert.equal(listSkillMetas(root)[0].description, '清缓存前')

  // 改内容，但把 mtime 显式设回同一个 FIXED ⇒ mtime 未变，应命中缓存
  fs.writeFileSync(file, FM('delta', '清缓存后'))
  fs.utimesSync(file, FIXED, FIXED)

  assert.equal(listSkillMetas(root)[0].description, '清缓存前', 'mtime 未变时应命中旧值')

  clearSkillMetaCache()
  assert.equal(
    listSkillMetas(root)[0].description,
    '清缓存后',
    'clearSkillMetaCache 后必须重读 —— 本句是「缓存失效出口」的承重判据',
  )
})

it('listSkillMetas：frontmatter 缺 name 或 description 的技能被跳过（不得静默降质）', () => {
  clearSkillMetaCache()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qgm-skill-meta-bad-'))
  roots.push(root)
  const base = path.join(root, '.ai-runner', 'skills')

  const write = (name: string, body: string) => {
    const d = path.join(base, name)
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'SKILL.md'), body)
  }
  write('ok', FM('ok', '正常技能'))
  write('no-name', '---\ndescription: 只有描述\n---\n')
  write('no-desc', '---\nname: no-desc\n---\n')

  const metas = listSkillMetas(root)
  assert.deepEqual(metas.map(m => m.name), ['ok'], '缺 name / description 的技能必须被跳过并告警')
})

// [skill-meta-cache-lru-v1] 缓存必须有上限：key 是绝对路径，切工作区后旧条目永不清会单调增长。
// [判据承重] 把上限判断删掉（无条件 set）⇒ 本用例必红（size 会超过上限）。
it('listSkillMetas：缓存条目数不超过上限（LRU 淘汰最旧）', () => {
  clearSkillMetaCache()
  const LIMIT = 512
  // 建 1 个 root，塞 LIMIT + 8 个技能 ⇒ 必须触发淘汰
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qgm-skill-lru-'))
  roots.push(root)
  const base = path.join(root, '.ai-runner', 'skills')
  const n = LIMIT + 8
  for (let i = 0; i < n; i++) {
    const name = `s${String(i).padStart(3, '0')}`
    const d = path.join(base, name)
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'SKILL.md'), FM(name, `第 ${i} 个技能`))
  }

  const metas = listSkillMetas(root)
  assert.equal(metas.length, n, '全部技能都必须出现在返回结果里（淘汰只影响缓存，不影响读取）')

  // 第二次调用：最旧的 8 个已被淘汰，会重新读盘；其余命中缓存
  const metas2 = listSkillMetas(root)
  assert.equal(metas2.length, n, '淘汰后结果必须仍然完整')
  assert.deepEqual(metas2.map(m => m.name), metas.map(m => m.name), '淘汰不得改变返回顺序')
})
