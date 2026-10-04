// [skill-retrieval-v1] e2e against real skills
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { rankSkills } from '../../../packages/core/src/skills/retriever.js'
import { realSkillDocs } from './fixtures/real-skills.js'

test('real corpus loaded', () => {
  assert.ok(realSkillDocs().length >= 10)
})

test('vue task ranks vue first', () => {
  const r = rankSkills('write a vue component with defineProps', realSkillDocs(), 3)
  console.log('vue:', r.map(x => `${x.name}=${x.score.toFixed(1)}`).join(','))
  assert.equal(r[0].name, 'vue')
})

test('vitest task ranks vitest first', () => {
  const r = rankSkills('add vitest unit tests with coverage', realSkillDocs(), 3)
  console.log('vitest:', r.map(x => `${x.name}=${x.score.toFixed(1)}`).join(','))
  assert.equal(r[0].name, 'vitest')
})
