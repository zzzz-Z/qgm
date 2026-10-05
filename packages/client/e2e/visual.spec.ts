// [ui-p2b-visual-v1] V7 视觉回归基线：5 视图 × 2 主题 = 10 张截图。
// [WHY] 计划要求「改任意样式后至少一张基线变红」；这里用 toHaveScreenshot 走 Playwright 内置像素对比。
// [CONSTRAINT] 首次运行须由复核方执行 --update-snapshots 生成基线；本 spec 不自带。
// [CONSTRAINT] 必须 mask 掉动态内容（时间戳 / AI 回复流），否则每次运行都红。
import { expect, test } from '@playwright/test'

if (process.env.NODE_TEST_CONTEXT) { process.exit(0) }

/** 稳定等待：等首帧骨架退场、字体加载完成 */
async function settle(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForSelector('.hdr', { timeout: 10_000 })
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => document.fonts && document.fonts.ready)
  await page.waitForTimeout(200)
}

/** 切主题：直接写 localStorage + data-theme，避开 UI 交互时序 */
async function setTheme(page: import('@playwright/test').Page, theme: 'dark' | 'light'): Promise<void> {
  await page.evaluate((t) => {
    try { localStorage.setItem('__ai_theme', t) } catch { /* ignore */ }
    document.documentElement.setAttribute('data-theme', t)
  }, theme)
  await page.waitForTimeout(300)
}

/** 动态区域遮罩：时间戳 / AI 输出流 / 交互态，避免基线抖动 */
const MASK_SELECTORS = ['.hms', '.term-body', '.cm-content', '.worklog-time', '.toast-host', '.tt-host']

for (const theme of ['dark', 'light'] as const) {
  test.describe(`视觉基线 · ${theme}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto('/')
      await setTheme(page, theme)
      await settle(page)
    })

    test(`01 首屏 · ${theme}`, async ({ page }) => {
      await expect(page).toHaveScreenshot(`01-home-${theme}.png`, {
        fullPage: false,
        mask: MASK_SELECTORS.map(s => page.locator(s)),
      })
    })

    test(`02 文件树 · ${theme}`, async ({ page }) => {
      await page.locator('.side-tab').nth(0).click()
      await page.waitForSelector('.tree .tree-head', { timeout: 5000 })
      await expect(page).toHaveScreenshot(`02-tree-${theme}.png`, {
        mask: MASK_SELECTORS.map(s => page.locator(s)),
      })
    })

    test(`03 变更面板 · ${theme}`, async ({ page }) => {
      await page.locator('.side-tab').nth(1).click()
      await page.waitForTimeout(300)
      await expect(page).toHaveScreenshot(`03-changes-${theme}.png`, {
        mask: MASK_SELECTORS.map(s => page.locator(s)),
      })
    })

    test(`04 任务面板 · ${theme}`, async ({ page }) => {
      await page.locator('.side-tab').nth(2).click()
      await page.waitForTimeout(300)
      await expect(page).toHaveScreenshot(`04-tasks-${theme}.png`, {
        mask: MASK_SELECTORS.map(s => page.locator(s)),
      })
    })

    test(`05 编辑器聚焦 · ${theme}`, async ({ page }) => {
      await page.locator('.cm-content').click()
      await page.waitForTimeout(200)
      await expect(page).toHaveScreenshot(`05-editor-${theme}.png`, {
        mask: MASK_SELECTORS.map(s => page.locator(s)),
      })
    })
  })
}
