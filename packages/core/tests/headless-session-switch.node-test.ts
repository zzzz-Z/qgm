// [headless-session-switch-v1] 「切工作区 = 切会话」的承重守卫（不新开浏览器，靠页面级导航）。
// [WHY] 用户的需求是「切工作区要切到该工作区对应的会话；没打开过就当新会话」。
//   无头侧原状：sid = `win_<modelId>`（同站点多工作区撞同一个键），`headless:open` 的 url
//   被整条丢弃、`pool.open` 命中已有会话直接 return ⇒ 页面一动不动，
//   B 工作区的提问续进 A 的对话（跨工作区串味，且 root 已经切到 B 的仓库）。
//   而按工作区各起一套 Chromium 不可行（poolLimit=5 / profile 独占锁 / 每实例数百 MB）。
// [CONSTRAINT] 四个断点各一条断言，缺任一都会退回「静默不切」：
//   ① 服务端消费 url；② 已有会话按 url 导航；③ 导航后就绪判定（输入框 + collector）；
//   ④ 上报 url-updated（客户端 confirmNav / 会话绑定回写都靠它）。
// [CONSTRAINT] 另两条是顺序契约，顺序错了功能「看起来有」但实际失效：
//   ⑤ fill 前取 URL 基线（否则该帧永不发出）；⑥ open 在 resetReplyDedup 之前（否则基线落在旧文档）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const WS = fs.readFileSync(path.join(ROOT, 'packages/core/src/server/attach-ws.ts'), 'utf8')
const HS = fs.readFileSync(path.join(ROOT, 'packages/core/src/headless/ai-headless.ts'), 'utf8')

/** 按花括号配平抠出从 `anchor` 起的代码块（本仓既有手法，见 poll-loop-reschedule） */
function block(s: string, anchor: string): string {
  const at = s.indexOf(anchor)
  if (at < 0) throw new Error(`未找到锚点「${anchor}」（结构变了，守卫需同步）`)
  const open = s.indexOf('{', at)
  let depth = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') { depth++ }
    else if (s[i] === '}') {
      depth--
      if (depth === 0) return s.slice(open, i + 1)
    }
  }
  throw new Error(`锚点「${anchor}」之后花括号未配平`)
}

const openCase = block(WS, 'headless:open')
const openFn = block(HS, 'async open(sid, url) {')
const navFn = block(HS, 'async function navigateSession(')

describe('[headless-session-switch-v1] 切工作区必须换会话，而不是什么都不做', () => {
  it('① 服务端 headless:open 必须把 url 交给 pool.open（原实现整条丢弃）', () => {
    expect(openCase, 'headless:open 未把 url 传给 pool.open ⇒ 客户端发的目标会话地址被静默吞掉').toMatch(
      /pool\.open\(sid,\s*wantUrl\s*\|\|\s*undefined\)/,
    )
    // 反向：不得再出现无 url 的裸调用（那样切工作区永远是 no-op）
    expect(openCase).not.toMatch(/await pool\.open\(sid\)\s*\n/)
  })

  it('①b 只有 nav=true 才导航（旧客户端每次 fill 都带 url，不能被拽回旧会话）', () => {
    expect(openCase, '未按 nav 门控 ⇒ 旧客户端的 fill 前 sendOpen 会触发导航').toMatch(
      /const wantUrl = msg\.nav === true \? String\(msg\.url \|\| ''\) : ''/,
    )
  })

  it('①c 切会话必须先摘掉旧的 reply poller（否则它接着读新页面、把无关正文当回复交付）', () => {
    expect(openCase, '切会话未停 replyPoller').toMatch(/replyPollers\.get\(sid\)/)
    const stopIdx = openCase.indexOf('stopPoll()')
    const openIdx = openCase.indexOf('pool.open(sid, wantUrl')
    expect(stopIdx, '应在 pool.open（导航）之前停 poller').toBeGreaterThan(-1)
    expect(stopIdx).toBeLessThan(openIdx)
  })

  it('② 已有会话必须按需导航（禁止 `if (existing && …) return existing` 裸返回）', () => {
    expect(openFn, 'open() 里 existing 分支必须比较目标 URL 并导航').toMatch(/sameNavTarget\(/)
    expect(openFn, 'existing 分支必须真的调用 navigateSession').toMatch(/await navigateSession\(sid,\s*existing,\s*url\)/)
    expect(openFn, '裸返回 existing 会让「切工作区」退化为 no-op').not.toMatch(
      /if \(existing && existing\.context\)\s*(?:\{\s*return existing\s*\}|return existing)/,
    )
    // 空 url 必须保持「仅确保会话存活」的旧语义：否则 fill 前的 sendOpen 会把页面拽回旧会话
    expect(openFn, 'url 为空时不得导航').toMatch(/if \(url && !sameNavTarget\(/)
  })

  it('③ 导航之后就绪判定：先 goto，再等输入框，最后重装 collector', () => {
    const gotoIdx = navFn.indexOf('page.goto(')
    const waitIdx = navFn.indexOf('waitForSelector(INPUT_SELECTOR')
    const collectorIdx = navFn.indexOf('ensureCollectorInPage')
    expect(gotoIdx, '导航函数里没有 goto').toBeGreaterThan(-1)
    expect(waitIdx, '导航后未等输入框 ⇒ 紧接着的 fill 必报 no-input-box').toBeGreaterThan(gotoIdx)
    expect(collectorIdx, '导航后未重装 collector ⇒ 新文档里 observer 全丢，回复采集退化').toBeGreaterThan(waitIdx)
    // 失败必须显式置 error（调用方据此 close+重建），不得静默吞掉
    expect(navFn).toMatch(/s\.state = 'error'/)
    expect(navFn).toMatch(/lastFillError\.set\(sid, detail\)/)
  })

  it('③b 目标会话失效时回退站点首页（过期绑定不得把整个通道打成 error）', () => {
    // 站点对不存在的会话会重定向到无输入框的页；油猴侧是「自己跳回首页」，无头侧必须对齐。
    expect(navFn, '导航失败后没有回退站点首页的路径').toMatch(/await go\(defaultUrl\)/)
    expect(navFn, '回退成功必须回到 idle（否则 fill 直接被 error 分支挡掉）').toMatch(/s\.url = defaultUrl[\s\S]{0,80}s\.state = 'idle'/)
    expect(navFn, '回退要留痕，否则「为什么跳出新对话」无从解释').toMatch(/navigate-fallback/)
  })

  it('④ open 之后必须上报 url-updated（confirmNav 与会话绑定回写都靠它）', () => {
    expect(openCase, '未上报 url-updated ⇒ 每次切工作区 8s 后必刷「绑定会话可能已失效」假告警').toMatch(
      /'headless:url-updated'/,
    )
    expect(openCase, '上报应以 idle 为条件（error 态没有可信 URL）').toMatch(/s\.state === 'idle'/)
  })

  it('⑤ URL 基线必须在 fill 之前取（否则 cur === prevUrl，该帧永不发出）', () => {
    const prevIdx = WS.indexOf('const prevUrl = page0')
    const fillIdx = WS.indexOf('const ok = await pool.fillPrompt(sid, prompt)')
    expect(prevIdx, '未找到 prevUrl 基线').toBeGreaterThan(-1)
    expect(fillIdx, '未找到 fillPrompt 调用').toBeGreaterThan(-1)
    expect(prevIdx, '基线取在 fill 之后 ⇒ 会话 URL 早已变完，url-updated 从不发布').toBeLessThan(fillIdx)
  })

  it('⑥ pool.open 必须在 resetReplyDedup 之前（基线不得落在旧文档上）', () => {
    const openIdx = WS.indexOf('sess = await pool.open(sid)\n      if (sess.state')
    const dedupIdx = WS.indexOf('await pool.resetReplyDedup(sid)')
    expect(openIdx, '未找到 handleFill 里的 pool.open（结构变了）').toBeGreaterThan(-1)
    expect(dedupIdx).toBeGreaterThan(-1)
    expect(openIdx, '先 reset 再 open ⇒ 基线取自旧文档，新会话首轮回复被判成「无新回复」').toBeLessThan(dedupIdx)
  })

  it('同站点多工作区仍共用一个浏览器：open 不得按 url 新建会话（防误改成 per-workspace 浏览器）', () => {
    // 用户明确「不独立浏览器，独立会话」：existing 分支只导航，不得 close/新建
    expect(openFn, 'existing 分支不得 close 会话（那就是 per-workspace 浏览器了）').not.toMatch(
      /if \(existing && existing\.context\)[\s\S]{0,200}?(?:this\.close|shutdown\()/,
    )
  })
})
