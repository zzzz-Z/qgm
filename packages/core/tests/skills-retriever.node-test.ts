// [skill-retrieval-v1] BM25 retriever behavior
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { rankSkills, tokenize } from '../../../packages/core/src/skills/retriever.js'

const DOCS = [
  { name: 'vue', description: 'Vue 3 Composition API, script setup macros, reactivity, defineProps, defineEmits, watchers', path: 'a' },
  { name: 'vite', description: 'Vite build tool configuration, plugin API, SSR, vite.config.ts', path: 'b' },
  { name: 'vitest', description: 'Vitest fast unit testing framework powered by Vite with Jest-compatible API, mocking, coverage', path: 'c' },
  { name: 'unocss', description: 'UnoCSS instant atomic CSS engine, utility rules, shortcuts, presets', path: 'd' },
  { name: 'systematic-debugging', description: 'Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes', path: 'e' },
  { name: 'webapp-testing', description: 'Interacts with and tests local web apps via Playwright, verify frontend functionality', path: 'f' },
]

test('tokenize: latin words lowercased', () => {
  const t = tokenize('Vue Composition API')
  assert.ok(t.includes('vue'))
  assert.ok(t.includes('composition'))
  assert.ok(t.includes('api'))
})

test('tokenize: CJK becomes bigrams', () => {
  const t = tokenize('\u7F16\u5199\u5355\u5143\u6D4B\u8BD5')
  assert.ok(t.includes('\u7F16\u5199'))
  assert.ok(t.includes('\u5355\u5143'))
})

test('tokenize: empty input yields empty array', () => {
  assert.deepEqual(tokenize(''), [])
})

test('rankSkills: vue task ranks vue skill first', () => {
  const r = rankSkills('write a vue component with defineProps', DOCS, 3)
  assert.ok(r.length > 0)
  assert.equal(r[0].name, 'vue')
})

test('rankSkills: vite config task ranks vite skill first', () => {
  const r = rankSkills('configure vite plugin for SSR build', DOCS, 3)
  assert.ok(r.length > 0)
  assert.equal(r[0].name, 'vite')
})

test('rankSkills: unit test task ranks vitest first', () => {
  const r = rankSkills('write vitest unit test with mocking and coverage', DOCS, 3)
  assert.ok(r.length > 0)
  assert.equal(r[0].name, 'vitest')
})

test('rankSkills: debugging task ranks systematic-debugging first', () => {
  const r = rankSkills('test failure with unexpected behavior, need to fix bug', DOCS, 3)
  assert.ok(r.length > 0)
  assert.equal(r[0].name, 'systematic-debugging')
})

test('rankSkills: unrelated query returns empty', () => {
  const r = rankSkills('quantum chromodynamics lattice gauge', DOCS, 3)
  assert.equal(r.length, 0)
})

test('rankSkills: empty query returns empty', () => {
  assert.deepEqual(rankSkills('', DOCS, 3), [])
})

test('rankSkills: empty docs returns empty', () => {
  assert.deepEqual(rankSkills('vue', [], 3), [])
})

test('rankSkills: limit respected', () => {
  const r = rankSkills('vue vite vitest build test component', DOCS, 2)
  assert.ok(r.length <= 2)
})

test('rankSkills: matched terms reported', () => {
  const r = rankSkills('vue component', DOCS, 1)
  assert.ok(r[0].matched.length > 0)
  assert.ok(r[0].matched.includes('vue'))
})

// --- v2: stopwords / df cutoff / score floor ---

test('v2: 停用词 with 不产生召回', () => {
  const docs = [
    { name: 'alpha', description: 'with the from into onto', path: 'a' },
    { name: 'beta', description: 'with a an the', path: 'b' },
  ]
  assert.deepEqual(rankSkills('with', docs, 3), [])
})

test('v2: use 作为停用词不参与匹配', () => {
  const docs = [
    { name: 'alpha', description: 'use when used using', path: 'a' },
  ]
  assert.deepEqual(rankSkills('use', docs, 3), [])
})

test('v2: 停用词不遮蔽真实词', () => {
  const docs = [
    { name: 'vue', description: 'Vue component with defineProps', path: 'a' },
    { name: 'browser', description: 'browser testing with devtools', path: 'b' },
  ]
  const r = rankSkills('write a vue component with defineProps', docs, 3)
  assert.equal(r[0].name, 'vue')
})

test('v2: 全库共现词被 df 截断剔除', () => {
  const docs = [
    { name: 'a', description: 'commonword alpha', path: 'a' },
    { name: 'b', description: 'commonword beta', path: 'b' },
    { name: 'c', description: 'commonword gamma', path: 'c' },
  ]
  assert.deepEqual(rankSkills('commonword', docs, 3), [])
})

test('v2: 低于分数下限不召回', () => {
  const docs = [{ name: 'alpha', description: 'one two three', path: 'a' }]
  const r = rankSkills('alpha', docs, 3)
  assert.ok(r.length <= 1)
})

test('v2: CJK 停用词 bigram 被剔除', () => {
  const t = tokenize('如何使用这个功能')
  assert.ok(!t.includes('使用'))
  assert.ok(!t.includes('这个'))
  assert.ok(!t.includes('如何'))
})
