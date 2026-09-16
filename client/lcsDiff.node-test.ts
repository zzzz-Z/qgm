import { it } from 'node:test'
import assert from 'node:assert/strict'

// lcsDiff 是 DiffViewer.vue 里的私有函数，这里复制一份来测。
// ponytail: 不抽公共模块（只有一处用），测试时复制可以接受。
function lcsDiff(a: string[], b: string[]): Array<{ type: string, text: string }> {
  const N = a.length
  const M = b.length
  if (N * M > 4_000_000) {
    const out: Array<{ type: string, text: string }> = []
    a.forEach(t => out.push({ type: 'del', text: t }))
    b.forEach(t => out.push({ type: 'add', text: t }))
    return out
  }
  const dp: number[][] = Array.from({ length: N + 1 }, () => new Array(M + 1).fill(0))
  for (let i = N - 1; i >= 0; i--) {
    for (let j = M - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: Array<{ type: string, text: string }> = []
  let i = 0; let j = 0
  while (i < N && j < M) {
    if (a[i] === b[j]) { out.push({ type: 'same', text: a[i] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: a[i] }); i++ }
    else { out.push({ type: 'add', text: b[j] }); j++ }
  }
  while (i < N) { out.push({ type: 'del', text: a[i] }); i++ }
  while (j < M) { out.push({ type: 'add', text: b[j] }); j++ }
  return out
}

it('完全相同 → 全 same', () => {
  const r = lcsDiff(['a', 'b', 'c'], ['a', 'b', 'c'])
  assert.equal(r.filter(x => x.type === 'same').length, 3)
  assert.equal(r.filter(x => x.type !== 'same').length, 0)
})

it('全新增', () => {
  const r = lcsDiff([], ['x', 'y'])
  assert.equal(r.filter(x => x.type === 'add').length, 2)
})

it('全删除', () => {
  const r = lcsDiff(['x', 'y'], [])
  assert.equal(r.filter(x => x.type === 'del').length, 2)
})

it('单行替换', () => {
  const r = lcsDiff(['a', 'b', 'c'], ['a', 'X', 'c'])
  assert.equal(r.filter(x => x.type === 'same').length, 2)
  assert.equal(r.filter(x => x.type === 'del' && x.text === 'b').length, 1)
  assert.equal(r.filter(x => x.type === 'add' && x.text === 'X').length, 1)
})

it('行移动（不是全删全增）', () => {
  const r = lcsDiff(['a', 'b', 'c'], ['a', 'c', 'b'])
  const sameCount = r.filter(x => x.type === 'same').length
  assert.ok(sameCount >= 2, `same 至少 2，实际 ${sameCount}`)
})

it('大文件 fallback（N*M > 4M）', () => {
  const a = Array.from({ length: 2100 }).fill(0).map((_, i) => `a${i}`)
  const b = Array.from({ length: 2100 }).fill(0).map((_, i) => `b${i}`)
  const r = lcsDiff(a, b)
  assert.equal(r.filter(x => x.type === 'del').length, 2100)
  assert.equal(r.filter(x => x.type === 'add').length, 2100)
})

it('空 vs 空', () => {
  const r = lcsDiff([], [])
  assert.equal(r.length, 0)
})
