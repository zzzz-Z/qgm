// [poll-loop-reschedule-v1] poll 循环**必须自我续命**的守卫。
// [WHY] 2026-10-18 实测事故：B 档把 tick 末尾的 `setTimeout(tick, 800)` 换成 `await waitForSignal(sid)`
//   却忘了重新调度 ⇒ tick 跑完第一拍就 return，整个 reply poll 永久静默。
//   用户侧表现是「fill-ack ok=true、state=generating，然后一条回复都收不到」，
//   而日志里只有**一条** poll-miss —— 这条「只有一拍」正是本事故的指纹。
//   惨痛之处在于：所有既有守卫都是「某项存在性」断言（有 collector、有 ack、有守卫），
//   没有一条约束「调度链不能断」。异步循环里漏一次续命，比抛异常更难发现（它不报错，只是停）。
// [CONSTRAINT] 断言必须咬住**形成闭环的最小条件**：任意出口都要么不调度（但只能是 stopped），
//   要么显式调度下一拍。只断言「出现过 setTimeout(tick)」是不够的（一个出口有、另一个没有照样断）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SRC = 'packages/core/src/headless/ai-headless.ts'
const src = fs.readFileSync(path.join(ROOT, SRC), 'utf8')

/** 抠出 tick 的函数体：从 `const tick = async () => {` 起按花括号配平（跳过注释里的括号影响可忽略，本函数体无字符串括号） */
function tickBody(s: string): string {
  const at = s.indexOf('const tick = async () => {')
  if (at < 0) throw new Error('未找到 tick 定义（结构变了，守卫需同步）')
  const open = s.indexOf('{', at)
  let depth = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++
    else if (s[i] === '}') {
      depth--
      if (depth === 0) return s.slice(open, i + 1)
    }
  }
  throw new Error('tick 函数体花括号未配平')
}

describe('[poll-loop-reschedule-v1] poll 循环不得断链', () => {
  const body = tickBody(src)

  it('tick 内至少两处 setTimeout(tick, …)：running 出口 + 正常出口都必须续命', () => {
    const n = (body.match(/setTimeout\(tick,/g) || []).length
    expect(n, 'tick 里续命调度少于 2 处 ⇒ 必有一个出口断了调度链（B 档事故原样）').toBeGreaterThanOrEqual(2)
  })

  it('禁止「await waitForSignal 后直接 return」的断链写法', () => {
    // 这正是事故写法：等完信号就 return，没有 setTimeout(tick)
    expect(body).not.toMatch(/await waitForSignal\(sid\)\s*;?\s*return\s*[}\n]/)
  })

  it('stopped 是唯一允许不调度的出口，且必须先判（否则停止后仍会无限续命）', () => {
    expect(body).toMatch(/if \(stopped\) return/)
    // running 出口必须带 !stopped 保护：停止后不得再续命
    expect(body).toMatch(/if \(!stopped\) setTimeout\(tick,/)
  })

  it('waitForSignal 调用次数与续命次数匹配（每次等待后面都要有对应调度）', () => {
    const waits = (body.match(/waitForSignal\(sid\)/g) || []).length
    const wakes = (body.match(/setTimeout\(tick,/g) || []).length
    expect(waits).toBeGreaterThanOrEqual(2)
    // 每个等待点后面都要有对应调度：wakes >= waits
    expect(wakes).toBeGreaterThanOrEqual(waits)
  })

  it('挂载 poller 的调用点 >= 2：handleFill 主路径 + 触顶自动恢复（P0-A 回归）', () => {
    // [WHY] 22:44 已把「单点 inline 挂载」抽成 armReplyPoll() wrapper（pool.startReplyPoll 只在 wrapper 内一处），
    //   所以这里断言的是 **wrapper 的调用点**，不是 pool.startReplyPoll 的出现次数。
    const ws = fs.readFileSync(path.join(ROOT, 'packages/core/src/server/attach-ws.ts'), 'utf8')
    const n = (ws.match(/armReplyPoll\(sid, send\)/g) || []).length
    expect(n, '恢复链若不再重挂 poller，新对话的回复无人采集（复核出的 P0-A）').toBeGreaterThanOrEqual(2)
  })
})
