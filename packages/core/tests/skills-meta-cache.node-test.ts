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
  // [判据承重] 本用例同时承担两件事：
  //   ① 「mtime 未变时命中缓存」——改内容但 mtime 不变，第二次调用必须返回旧值；
  //   ② 「clearSkillMetaCache 后强制重读」——清缓存后必须看到新值。
  // [CONSTRAINT] 不再单独写一条「mtime 未变」用例：它依赖 utimesSync 精确还原 mtime，
  //   而 Date 只有毫秒精度、原始 mtimeMs 带小数，跨平台还原后必然漂移，会让用例随机红。
  clearSkillMetaCache()
  const { root, file } = mkSkill('delta', FM('delta', '清缓存前'))
  const st = fs.statSync(file)
  assert.equal(listSkillMetas(root)[0].description, '清缓存前')

  fs.writeFileSync(file, FM('delta', '清缓存后'))
  fs.utimesSync(file, st.atime, st.mtime) // 保持 mtime 不变

  assert.equal(listSkillMetas(root)[0].description, '清缓存前', '未清缓存时应命中旧值')
  clearSkillMetaCache()
  assert.equal(listSkillMetas(root)[0].description, '清缓存后', 'clearSkillMetaCache 后必须重读')
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
