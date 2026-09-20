import { expect, test } from '@playwright/test'

test.describe('AI Runner', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('.hdr', { timeout: 10_000 })
  })

  test('header 显示核心控件', async ({ page }) => {
    await expect(page.locator('h1')).toContainText('AI Runner')
    await expect(page.locator('.settings-toggle')).toBeVisible()
  })

  test('编辑器（CodeMirror）可见', async ({ page }) => {
    await expect(page.locator('.cm-content')).toBeVisible({ timeout: 10_000 })
  })

  test('侧栏三 tab 可切换（树/变更/记录）', async ({ page }) => {
    const tabs = page.locator('.side-tab')
    await expect(tabs).toHaveCount(3)
    await tabs.nth(2).click()
    await expect(page.locator('.trace-panel')).toBeVisible({ timeout: 5000 })
    await tabs.nth(0).click()
    await expect(page.locator('.tree .tree-head')).toBeVisible({ timeout: 5000 })
  })

  test('运行按钮可见', async ({ page }) => {
    await expect(page.locator('.primary-btn.head-run').first()).toBeVisible({ timeout: 5000 })
  })
})
