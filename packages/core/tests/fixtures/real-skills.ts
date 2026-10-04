// [skill-retrieval-v1] load real SKILL.md metadata from .ai-runner/skills for e2e tests
import fs from 'node:fs'
import path from 'node:path'
import type { SkillDoc } from '../../src/skills/retriever.js'

export function realSkillDocs(): SkillDoc[] {
  const dir = path.join(process.cwd(), '.ai-runner', 'skills')
  const docs: SkillDoc[] = []
  if (!fs.existsSync(dir)) return docs
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue
    const file = path.join(dir, ent.name, 'SKILL.md')
    if (!fs.existsSync(file)) continue
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    let name = ''
    let description = ''
    let keywords: string | undefined
    if (lines[0] === '---') {
      for (let i = 1; i < lines.length; i += 1) {
        if (lines[i] === '---') break
        if (lines[i].startsWith('name:')) name = lines[i].slice(5).trim()
        if (lines[i].startsWith('description:')) description = lines[i].slice(12).trim()
        if (lines[i].startsWith('keywords:')) keywords = lines[i].slice(9).trim()
      }
    }
    if (name && description) docs.push({ name, description, keywords, path: `.ai-runner/skills/${ent.name}/SKILL.md` })
  }
  return docs
}
