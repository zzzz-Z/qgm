// [fs-watch-v1] 承重判据：变更路径 → 已展开祖先目录枚举
import { describe, expect, it } from 'vitest'
import { computeAffectedDirs } from '../composables/data/useFileTree'

const all = () => true
const none = () => false

describe('computeAffectedDirs', () => {
  it('单文件：祖先目录 + 自身都在受影响集', () => {
    expect([...computeAffectedDirs(['a/b/c.ts'], all)].sort()).toEqual(['a', 'a/b', 'a/b/c.ts'])
  })
  it('未展开目录被过滤', () => {
    const ex = new Set(['a'])
    expect([...computeAffectedDirs(['a/b/c.ts'], d => ex.has(d))]).toEqual(['a'])
  })
  it('恒假 isExpanded → 空集（变异验证锚点）', () => {
    expect(computeAffectedDirs(['a/b/c.ts'], none).size).toBe(0)
  })
  it('多路径去重', () => {
    const r = computeAffectedDirs(['a/b/x.ts', 'a/b/y.ts', 'a/z.ts'], all)
    expect([...r].sort()).toEqual(['a', 'a/b', 'a/b/x.ts', 'a/b/y.ts', 'a/z.ts'])
  })
  it('空路径/空数组不产生垃圾项', () => {
    expect(computeAffectedDirs([], all).size).toBe(0)
    expect(computeAffectedDirs(['', 'a.ts'], all).size).toBe(1)
  })
  it('不修改输入', () => {
    const i = ['a/b/c.ts']
    const s = [...i]
    computeAffectedDirs(i, all)
    expect(i).toEqual(s)
  })
})
