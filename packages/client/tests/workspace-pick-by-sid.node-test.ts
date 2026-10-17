// [workspace-sid-ambiguity-v1] pickWorkspaceBySid 的承重判据。
// [WHY] 原实现 host 多命中取最后一个（对象遍历顺序），实测把 admin-template 写进 web-ai-qgm 的会话数据。
//   判据必须承重：把「多命中返回 null」改回「取 hit」会让用例变红。
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { pickWorkspaceBySid } from '../composables/data/useWorkspaces.js'

function sidOf(u: string) {
  try {
    const h = new URL(u).host
    if (h === 'chat.deepseek.com') return 'win_deepseek'
    return 'win_default'
  } catch { return 'win_default' }
}

describe('pickWorkspaceBySid（workspace-sid-ambiguity-v1）', () => {
  const A = '94a803325b6a'
  const B = '23dab63f5a1d'
  const C = '2f00a56105a0'

  it('精确 URL 命中优先（同站点多工作区唯一）', () => {
    const sessions = {
      [A]: { url: 'https://chat.deepseek.com/' },
      [B]: { url: 'https://chat.deepseek.com/a/chat/s/2760cc84' },
      [C]: { url: 'https://chat.deepseek.com/' },
    }
    assert.equal(
      pickWorkspaceBySid(sessions, 'win_deepseek', 'https://chat.deepseek.com/a/chat/s/2760cc84', sidOf),
      B,
    )
  })

  it('host 唯一命中返回该工作区', () => {
    const sessions = {
      [A]: { url: 'https://chat.deepseek.com/' },
      [B]: { url: 'https://www.qianwen.com/' },
    }
    assert.equal(
      pickWorkspaceBySid(sessions, 'win_deepseek', 'https://chat.deepseek.com/a/chat/s/new', sidOf),
      A,
    )
  })

  it('host 多命中返回 null（承重：改回取 hit 会变红）', () => {
    const sessions = {
      [A]: { url: 'https://chat.deepseek.com/' },
      [B]: { url: 'https://chat.deepseek.com/' },
      [C]: { url: 'https://chat.deepseek.com/' },
    }
    assert.equal(
      pickWorkspaceBySid(sessions, 'win_deepseek', 'https://chat.deepseek.com/a/chat/s/new', sidOf),
      null,
    )
  })

  it('sid 为空返回 null', () => {
    assert.equal(pickWorkspaceBySid({}, '', 'https://x/', sidOf), null)
  })

  it('全未命中返回 null', () => {
    assert.equal(
      pickWorkspaceBySid({ [A]: { url: 'https://x.com/' } }, 'win_deepseek', 'https://chat.deepseek.com/', sidOf),
      null,
    )
  })
})
