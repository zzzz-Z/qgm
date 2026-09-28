// 若被 node --test 拾取（NODE_TEST_CONTEXT 由 node 子进程自动设置），立即退出
// Playwright runner 不设该变量，不影响 pnpm test:e2e
import { expect, test } from '@playwright/test'

if (process.env.NODE_TEST_CONTEXT) { process.exit(0) }

test.describe('AI Runner', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('.hdr', { timeout: 10_000 })
  })

  test('header 显示核心控件', async ({ page }) => {
    await expect(page.locator('h1')).toContainText('AI Runner')
  })

  test('编辑器（CodeMirror）可见', async ({ page }) => {
    await expect(page.locator('.cm-content')).toBeVisible({ timeout: 10_000 })
  })

  test('侧栏 tab 可切换（树/变更/任务）', async ({ page }) => {
    const tabs = page.locator('.side-tab')
    await expect(tabs).toHaveCount(3)
    await tabs.nth(0).click()
    await expect(page.locator('.tree .tree-head')).toBeVisible({ timeout: 5000 })
  })

  test('运行按钮可见', async ({ page }) => {
    await expect(page.locator('.primary-btn.head-run').first()).toBeVisible({ timeout: 5000 })
  })
})
