// [login-token-guard-test-v1] 回归测试：锁定「登录态判定」的三态语义
// [WHY] 未登录时 DeepSeek 会先渲染聊天骨架（path=/、输入框短暂存在），token 校验失败后才跳 /sign_in。
//       只凭「path 非 /sign_in + 有输入框」会把这段闪现误判成已登录：实测 open 返回假 idle、
//       login-gui 开窗 17s 即误报「已检测到登录成功」并自动关窗。userToken 是唯一的真实信号。
// [CONSTRAINT] headless-inject 是浏览器上下文代码（@ts-nocheck），这里手工桩 window/location/document
import { describe, expect, it } from 'vitest'
import { detectLoginStateInPage } from '../src/headless/headless-inject.js'

/** 桩出浏览器全局对象；tokenRaw=null 表示 localStorage 里没有 userToken 这个键 */
function stubBrowserEnv(tokenRaw: string | null, opts: { pathname?: string, hasInput?: boolean } = {}) {
  const g = globalThis as unknown as Record<string, unknown>
  g.window = { localStorage: { getItem: (k: string) => (k === 'userToken' ? tokenRaw : null) } }
  g.location = { pathname: opts.pathname ?? '/' }
  g.document = { querySelector: () => (opts.hasInput ? { tagName: 'TEXTAREA' } : null) }
}

describe('detectLoginStateInPage 登录态三态判定', () => {
  it('userToken.value 非空 → yes（确认已登录）', () => {
    stubBrowserEnv(JSON.stringify({ value: 'eyJhbGciOi.token' }))
    expect(detectLoginStateInPage().tokenState).toBe('yes')
  })

  it('userToken.value 为 null → no（确认未登录，这是被踢下线的真实形态）', () => {
    stubBrowserEnv(JSON.stringify({ value: null }))
    expect(detectLoginStateInPage().tokenState).toBe('no')
  })

  it('userToken.value 为空字符串 → no', () => {
    stubBrowserEnv(JSON.stringify({ value: '' }))
    expect(detectLoginStateInPage().tokenState).toBe('no')
  })

  it('localStorage 无 userToken 键 → unknown（非 DeepSeek 部署放行，不误伤）', () => {
    stubBrowserEnv(null)
    expect(detectLoginStateInPage().tokenState).toBe('unknown')
  })

  it('userToken 非法 JSON → unknown（解析失败不当作负证据）', () => {
    stubBrowserEnv('{not json')
    expect(detectLoginStateInPage().tokenState).toBe('unknown')
  })

  it('透传 path 与输入框存在性', () => {
    stubBrowserEnv(JSON.stringify({ value: null }), { pathname: '/sign_in', hasInput: true })
    const st = detectLoginStateInPage()
    expect(st.path).toBe('/sign_in')
    expect(st.hasInput).toBe(true)
    expect(st.tokenState).toBe('no')
  })
})
