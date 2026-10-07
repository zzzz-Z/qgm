import { expect, test } from '@playwright/test'

if (process.env.NODE_TEST_CONTEXT) { process.exit(0) }

test.describe('strip-script-blocks 端到端', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('.hdr', { timeout: 10_000 })
    await page.waitForSelector('.terminal', { timeout: 10_000 })
    await page.evaluate(() => {
      const w = window as unknown as { __AI_EVENT_HOOKS__?: { clear: () => void } }
      w.__AI_EVENT_HOOKS__?.clear()
    })
  })

  test('含脚本块的 ai:plain 事件 ⇒ text 卡只留说明文本', async ({ page }) => {
    await page.evaluate(() => {
      const w = window as unknown as { __AI_EVENT_HOOKS__?: { emit: (k: string, s: string, o?: Record<string, unknown>) => void } }
      const F = String.fromCharCode(96).repeat(3)
      const text = ['先说明：', `${F}js`, '#! /usr/bin/env node', '// @desc 做某事', 'console.log("SHOULD_NOT_RENDER")', F, '后记。'].join(String.fromCharCode(10))
      w.__AI_EVENT_HOOKS__?.emit('ai:plain', 'probe', { payload: { text } })
    })
    await page.waitForTimeout(300)

    const cardText = await page.locator('.text-card').first().textContent().catch(() => '')
    console.log('[e2e] cardText=', JSON.stringify(cardText.slice(0, 300)))
    expect(cardText).toContain('先说明')
    expect(cardText).toContain('后记')
    expect(cardText).not.toContain('SHOULD_NOT_RENDER')
    expect(cardText).not.toContain('#!')
  })

  test('纯脚本 ai:plain 事件 ⇒ 不渲染 text 卡', async ({ page }) => {
    const before = await page.locator('.text-card').count()
    await page.evaluate(() => {
      const w = window as unknown as { __AI_EVENT_HOOKS__?: { emit: (k: string, s: string, o?: Record<string, unknown>) => void } }
      const F = String.fromCharCode(96).repeat(3)
      const text = [`${F}js`, '#! /usr/bin/env node', '// @desc x', 'console.log(1)', F].join(String.fromCharCode(10))
      w.__AI_EVENT_HOOKS__?.emit('ai:plain', 'probe2', { payload: { text } })
    })
    await page.waitForTimeout(300)
    const after = await page.locator('.text-card').count()
    expect(after).toBe(before)
  })
})
