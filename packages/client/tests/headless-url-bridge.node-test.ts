// [headless-url-bridge-v1] 无头侧 url-updated / new-session-created 两条帧的接线守卫。
// [WHY] 传输层早就定义了 onUrlUpdated / onNewSessionCreated，但客户端**从来没有订阅**——
//   两条帧落到空集合（`urlUpdatedCbs` 无人注册），后果全是静默的：
//   ① `confirmNav` 永不触发 ⇒ 每次切工作区 8s 后必刷一条「绑定的会话可能已失效」假告警；
//   ② `persistSessionBinding` 永不执行 ⇒ 无头侧从不回写工作区会话绑定，
//      绑定永远停在 kind:'site' 的首页 URL ⇒ 就算服务端支持导航，也没有「对应会话」可切。
// [CONSTRAINT] 另一条同族约束：fill 前那次 sendOpen 不得带 url。
//   服务端 headless:open 现在会按 url 导航，若 fill 仍带 url.value（视野里的上一次会话），
//   刚切好的会话会在 fill 前被拽回旧对话 —— 提问落进错的工作区。导航只由 openSite 显式发起。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const STARTUP = fs.readFileSync(path.join(ROOT, 'packages/client/composables/ui/useAppStartup.ts'), 'utf8')
const AIWIN = fs.readFileSync(path.join(ROOT, 'packages/client/composables/ai/useAiWindow.ts'), 'utf8')

describe('[headless-url-bridge-v1] 无头 URL 帧必须桥接到消息分发器', () => {
  it('订阅 onUrlUpdated，并转成 ai-runner:url-updated 喂给 onSessionIdMessage', () => {
    expect(STARTUP, '未订阅 onUrlUpdated ⇒ confirmNav / 会话绑定回写在无头侧永不发生').toMatch(
      /transport\.onUrlUpdated\?\.\(\(url: string, sid: string\)/,
    )
    expect(STARTUP, '桥接帧的 type 必须与分发器判据逐字一致').toMatch(/type: 'ai-runner:url-updated'/)
    expect(STARTUP, '转出的帧未被送入分发器').toMatch(/onSessionIdMessage\(fake\)/)
  })

  it('订阅 onNewSessionCreated，并转成 ai-runner:new-session-created', () => {
    expect(STARTUP).toMatch(/transport\.onNewSessionCreated\(\(url: string, id: string\)/)
    expect(STARTUP).toMatch(/type: 'ai-runner:new-session-created'/)
  })

  it('两条订阅都必须可退订（HMR / 卸载后不得重复注册）', () => {
    expect(STARTUP, '未保存 onUrlUpdated 的取消句柄').toMatch(/_offHeadlessUrl = transport\.onUrlUpdated/)
    expect(STARTUP, '未保存 onNewSessionCreated 的取消句柄').toMatch(/_offHeadlessNewSid = transport\.onNewSessionCreated/)
    expect(STARTUP, 'onUnmounted 未退订 onUrlUpdated').toMatch(/_offHeadlessUrl\?\.\(\)/)
    expect(STARTUP, 'onUnmounted 未退订 onNewSessionCreated').toMatch(/_offHeadlessNewSid\?\.\(\)/)
  })
})

describe('[headless-session-switch-v1] fill 前不带 url，导航只由 openSite 发起', () => {
  it('copyAndFill 的 headless 分支必须发空 payload', () => {
    expect(AIWIN, 'fill 前带 url 会把刚切好的会话拽回旧对话').not.toMatch(/sendOpen\?\.\(hsSid,\s*\{\s*url:/)
    expect(AIWIN, 'headless fill 前仍需要「确保会话存活」的 open 帧').toMatch(/sendOpen\?\.\(hsSid,\s*\{\}\)/)
  })

  it('openSite 仍必须带 url 且显式 nav:true（切工作区/开新会话的导航入口）', () => {
    expect(AIWIN).toMatch(/sendOpen\?\.\(useSid,\s*\{\s*url: atUrl \?\? url\.value,\s*nav: true\s*\}\)/)
  })

  it('传输层必须把 nav 透传出去（缺省 false，旧行为不导航）', () => {
    const TRANSPORT = fs.readFileSync(path.join(ROOT, 'packages/client/composables/ai/useAiTransport.ts'), 'utf8')
    expect(TRANSPORT).toMatch(/send\('headless:open',\s*\{\s*sid,\s*url: p\.url,\s*nav: p\.nav === true\s*\}\)/)
  })
})
