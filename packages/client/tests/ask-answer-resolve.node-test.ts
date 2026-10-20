// @desc [ask-answer-resolve-any-v1] 守卫：answerAsk 兑现活跃提问不得按 id 相等判定
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = readFileSync(resolve(__dirname, '../composables/ui/useAsk.ts'), 'utf8')

describe('answerAsk resolve（ask-answer-resolve-any-v1）', () => {
  it('不得用 s.id === id 作为 resolve 前提', () => {
    const fn = SRC.slice(SRC.indexOf('export function answerAsk'))
    const body = fn.slice(0, fn.indexOf('\n}'))
    const bad = /if \(s && s\.id === id\)[^\n]*\.resolve\(/.test(body)
    expect(bad, '不得按 id 相等才 resolve').toBe(false)
  })

  it('必须无条件兑现活跃提问', () => {
    const fn = SRC.slice(SRC.indexOf('export function answerAsk'))
    const body = fn.slice(0, fn.indexOf('\n}'))
    const good = /if \(s\)\s*s\.resolve\(answer\)/.test(body)
    expect(good, '必须无条件 resolve').toBe(true)
  })
})
