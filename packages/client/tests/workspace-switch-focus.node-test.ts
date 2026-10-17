// [workspace-switch-focus-v1] 切工作区时受控 AI 窗口必须先于网络请求聚焦。
// [WHY] user activation 只在同步栈内有效；activate 里任何 await 之后再调 win.focus() 都会被浏览器拒绝
//   （用户报告「切了工作区但 DeepSeek 窗口没到前台」）。openSite 内的 focus 在多个 await 之后，救不回来。
// [承重] 把 focus 挪到第一个 await 之后 → 第一条用例必红。
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = readFileSync(resolve(process.cwd(), 'packages/client/composables/data/useWorkspaces.ts'), 'utf8')

// 剥行注释：注释里的 "await " 字样会让 indexOf 误判（本项目踩坑记录的同类陷阱）
function stripLineComments(s: string): string {
  return s.split('\n').map((l) => {
    const i = l.indexOf('//')
    return i >= 0 ? l.slice(0, i) : l
  }).join('\n')
}

function bodyOf(name: string): string {
  const i = SRC.indexOf(name)
  assert.ok(i > 0, `${name} 不存在：结构已变，守卫需同步`)
  // 从 name 后的第一个「行尾 {」开始：跳过参数 / 返回值里的类型字面量 {…}
  let start = -1
  for (let k = i; k < SRC.length; k++) {
    if (SRC[k] === '{') {
      let j = k + 1
      while (j < SRC.length && (SRC[j] === ' ' || SRC[j] === '\t' || SRC[j] === '\r')) j++
      if (SRC[j] === '\n') { start = k; break }
    }
  }
  assert.ok(start > 0, `${name} 函数体起始 { 未找到`)
  let depth = 0
  for (let k = start; k < SRC.length; k++) {
    if (SRC[k] === '{') { depth++
    }
    else if (SRC[k] === '}') { depth--; if (depth === 0) return SRC.slice(start, k + 1) }
  }
  throw new Error('未找到函数体边界')
}

describe('workspace-switch-focus-v1（源码断言）', () => {
  it('activate 内 focus 必须出现在首个 await 之前（承重）', () => {
    const b = stripLineComments(bodyOf('async function activate('))
    const awaitIdx = b.indexOf('await fetch(')
    const focusIdx = b.indexOf('win?.focus()')
    assert.ok(awaitIdx > 0, 'activate 内应有 await fetch')
    assert.ok(focusIdx > 0, 'activate 内未找到 win?.focus() 同步调用')
    assert.ok(focusIdx < awaitIdx, 'focus 必须在第一个 await 之前（user activation 已过期）')
  })

  it('useWorkspaces 静态导入 useAiWindowTable 的 getWindowBySidImpl / getActiveWinSidImpl', () => {
    assert.ok(
      /import \{[^}]*getActiveWinSidImpl[^}]*\} from '\.\.\/ai\/useAiWindowTable'/.test(SRC),
      '缺 getActiveWinSidImpl 静态导入',
    )
    assert.ok(
      /import \{[^}]*getWindowBySidImpl[^}]*\} from '\.\.\/ai\/useAiWindowTable'/.test(SRC),
      '缺 getWindowBySidImpl 静态导入',
    )
  })

  it('activate 按目标工作区绑定推导 sid（跨站点切换聚焦正确窗口）', () => {
    const b = stripLineComments(bodyOf('async function activate('))
    assert.ok(/workspaces\.value\.find\(w => w\.id === id\)/.test(b), 'activate 内未按 id 查本地快照')
    assert.ok(/sidForUrl\(targetUrl\)/.test(b), 'activate 内未按绑定 url 反推 targetSid')
    const focusIdx = b.indexOf('sidForUrl(targetUrl)')
    const awaitIdx = b.indexOf('await fetch(')
    assert.ok(focusIdx > 0 && awaitIdx > 0 && focusIdx < awaitIdx, 'sid 推导必须在首个 await fetch 之前')
  })

  it('getWindowBySidImpl 回退当前激活窗口（目标窗口未开时仍聚焦）', () => {
    const b = stripLineComments(bodyOf('async function activate('))
    assert.ok(/getWindowBySidImpl\(targetSid\) \?\? getWindowBySidImpl\(getActiveWinSidImpl\(\)\)/.test(b), '缺回退逻辑')
  })
})
