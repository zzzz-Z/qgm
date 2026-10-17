// [workspace-schema-v2] pickNavUrl：切工作区时的导航目标选择。
// [WHY] homeUrl 与 sessionUrl 分离后，必须由单一纯函数决定「回会话」还是「新建」。
//   抽成纯函数是为了能在这里直接覆盖三分支（R1 修复前数据源是合并形状，分支不可实现）。
// [承重] 把「sessionUrl 非空则返回它」改成恒返回 homeUrl → 第二例必红。
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { pickNavUrl } from '../composables/data/useWorkspaces.js'

describe('pickNavUrl（workspace-schema-v2）', () => {
  it('sessionUrl 非空 ⇒ 导航到具体会话（复用语义）', () => {
    assert.equal(
      pickNavUrl({ sessionUrl: 'https://chat.deepseek.com/a/chat/s/abc', homeUrl: 'https://chat.deepseek.com/', newSession: false, fallbackUrl: 'https://x/' }),
      'https://chat.deepseek.com/a/chat/s/abc',
    )
  })

  it('sessionUrl 为空、homeUrl 非空 ⇒ 导航到站点首页（新建语义）', () => {
    assert.equal(
      pickNavUrl({ sessionUrl: '', homeUrl: 'https://chat.deepseek.com/', newSession: false, fallbackUrl: 'https://x/' }),
      'https://chat.deepseek.com/',
    )
  })

  it('两者皆空 ⇒ 回退 currentSiteUrl', () => {
    assert.equal(
      pickNavUrl({ sessionUrl: '', homeUrl: '', newSession: false, fallbackUrl: 'https://fallback/' }),
      'https://fallback/',
    )
  })

  it('newSession 强制走 homeUrl（即使 sessionUrl 非空）', () => {
    assert.equal(
      pickNavUrl({ sessionUrl: 'https://chat.deepseek.com/a/chat/s/abc', homeUrl: 'https://chat.deepseek.com/', newSession: true, fallbackUrl: 'https://x/' }),
      'https://chat.deepseek.com/',
    )
  })

  it('newSession 且 homeUrl 为空 ⇒ 回退 currentSiteUrl', () => {
    assert.equal(
      pickNavUrl({ sessionUrl: 'https://chat.deepseek.com/a/chat/s/abc', homeUrl: '', newSession: true, fallbackUrl: 'https://fallback/' }),
      'https://fallback/',
    )
  })
})
