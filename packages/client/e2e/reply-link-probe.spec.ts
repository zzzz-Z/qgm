import { expect, test } from '@playwright/test'

if (process.env.NODE_TEST_CONTEXT) { process.exit(0) }

// [reply-link-probe-v1] 走真实回传链路（postMessage → useAiReplyHandlers → 事件流 → text 卡）
// 与 strip-script-blocks.spec.ts 的区别：那个直接 emit 事件（绕过分流），这个走完整链路。
test.describe('真实回传链路 · plain 含脚本', () => {
  test('围栏格式：脚本块不进 text 卡', async ({ page }) => {
    await page.goto('/?mock=1')
    await page.waitForSelector('.terminal', { timeout: 10_000 })
    await page.evaluate(() => {
      const F = String.fromCharCode(96).repeat(3)
      const NL = String.fromCharCode(10)
      const text = ['说明文字', `${F}js`, '#! /usr/bin/env node', '// @desc x', 'console.log("NOISE_FENCED")', F, '后记'].join(NL)
      window.postMessage({ type: 'ai-runner:reply', kind: 'plain', text }, '*')
    })
    await page.waitForTimeout(500)
    const t = await page.locator('.text-card').first().textContent().catch(() => '')
    console.log('[link] fenced cardText=', JSON.stringify((t || '').slice(0, 200)))
    expect(t).toContain('说明文字')
    expect(t).not.toContain('NOISE_FENCED')
  })

  test('无围栏（DOM 反推丢失）：脚本行不进 text 卡', async ({ page }) => {
    await page.goto('/?mock=1')
    await page.waitForSelector('.terminal', { timeout: 10_000 })
    await page.evaluate(() => {
      const NL = String.fromCharCode(10)
      const text = ['说明文字', '#! /usr/bin/env node', '// @desc x', 'console.log("NOISE_RAW")', '后记'].join(NL)
      window.postMessage({ type: 'ai-runner:reply', kind: 'plain', text }, '*')
    })
    await page.waitForTimeout(500)
    const t = await page.locator('.text-card').first().textContent().catch(() => '')
    console.log('[link] raw cardText=', JSON.stringify((t || '').slice(0, 200)))
    expect(t).toContain('说明文字')
    expect(t).not.toContain('NOISE_RAW')
  })
})
