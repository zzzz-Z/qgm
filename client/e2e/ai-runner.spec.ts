import { expect, test } from '@playwright/test'

test.describe('AI Runner', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('.hdr', { timeout: 10_000 })
  })

  const tabButtons = (page: import('@playwright/test').Page) =>
    page.locator('.tabs button:not(.tabs-burger)')

  test('header 显示核心控件', async ({ page }) => {
    await expect(page.locator('h1')).toContainText('AI Runner')
    await expect(page.locator('.settings-toggle')).toBeVisible()
    await expect(page.locator('.ds-url')).toBeVisible()
  })

  test('三个标签可切换', async ({ page }) => {
    const tabs = tabButtons(page)
    await expect(tabs).toHaveCount(3)
    await tabs.nth(1).click()
    await expect(page.locator('.editor-content')).toBeVisible()
    await tabs.nth(2).click()
    await expect(page.locator('.trace-panel')).toHaveCount(1)
  })

  test('生成问题：@ 呼出检索面板', async ({ page }) => {
    await tabButtons(page).nth(1).click()
    const editor = page.locator('.editor-content')
    await editor.click()
    await page.keyboard.type('@')
    await expect(page.locator('.at-popover')).toBeVisible({ timeout: 3000 })
    await page.keyboard.press('Escape')
    await expect(page.locator('.at-popover')).toBeHidden()
  })

  test('生成问题：拖文件到输入区', async ({ page }) => {
    await tabButtons(page).nth(1).click()
    await page.waitForSelector('.tree-head .title')

    // 展开 src 目录（若未展开）
    const srcRow = page.locator('.row.dir', { hasText: 'src' }).first()
    if (await srcRow.count()) await srcRow.click()

    // 找第一个文件行
    const fileRow = page.locator('.row.file').first()
    await fileRow.waitFor({ timeout: 5000 })

    // 模拟 pointer 拖拽：因为用自定义 pointer 事件，Playwright 的 dragTo 不适用
    const box = await fileRow.boundingBox()
    if (!box) throw new Error('no bounding box')
    const target = page.locator('.editor-content')
    const tBox = await target.boundingBox()
    if (!tBox) throw new Error('no target box')

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(tBox.x + tBox.width / 2, tBox.y + tBox.height / 2, { steps: 15 })
    await page.mouse.up()

    // 期望出现 file-tag
    await expect(page.locator('.file-tag')).toHaveCount(1, { timeout: 5000 })
  })

  test('claim mismatch：声明但未改动入 prompt', async ({ page }) => {
    await tabButtons(page).nth(0).click()
    const editor = page.locator('.cm-content')
    await editor.click()
    await page.keyboard.type('#!/usr/bin/env node', { delay: 5 })
    await page.keyboard.press('Enter')
    await page.keyboard.type('// @changes: src/never-written.ts', { delay: 5 })
    await page.keyboard.press('Enter')
    await page.keyboard.type('console.log("noop")', { delay: 5 })
    await page.locator('.primary-btn.run').click()
    await expect(page.locator('.exit-badge.ok')).toBeVisible({ timeout: 15_000 })
    await page.evaluate(() => {
      ;(window as any).__copied = ''
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (t: string) => { (window as any).__copied = t },
          readText: async () => (window as any).__copied,
        },
      })
    })
    await page.locator('.term-btn.copy').click()
    const copied = await page.evaluate(() => (window as any).__copied as string)
    expect(copied).toContain('# 脚本声明的改动 vs 实际改动')
    expect(copied).toContain('声明但未改动')
    expect(copied).toContain('脚本未产生任何文件改动')
  })

  test('运行脚本：终端有输出', async ({ page }) => {
    await tabButtons(page).nth(0).click()
    const editor = page.locator('.cm-content')
    await editor.click()
    await page.keyboard.type('#!/usr/bin/env node', { delay: 5 })
    await page.keyboard.press('Enter')
    await page.keyboard.type('console.log("hello from e2e")', { delay: 5 })
    await page.locator('.primary-btn.run').click()

    // 等终端出现 hello
    await expect(page.locator('.term-body')).toContainText('hello from e2e', { timeout: 15_000 })
    await expect(page.locator('.exit-badge.ok')).toBeVisible()
  })
})
