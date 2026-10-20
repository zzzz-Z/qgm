// 若被 node --test 拾取（NODE_TEST_CONTEXT 由 node 子进程自动设置），立即退出
// Playwright runner 不设该变量，不影响 pnpm test:e2e
import { expect, test } from '@playwright/test'

if (process.env.NODE_TEST_CONTEXT) { process.exit(0) }

test.describe('AI Runner', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('.layout-row', { timeout: 10_000 })
  })

  test('工作区侧栏存在（左栏容器挂载）', async ({ page }) => {
    // [spec-align-v3] useFoldState 默认 expanded=false ⇒ 左栏默认折叠，内部元素被 CSS 隐藏；
    //   原断言 h1「QGM」/「新建工作区按钮」的可见性都随折叠态变化，不稳定。
    //   改为断言与折叠态无关的结构：aside 容器存在（Playwright 的 toHaveCount 不受 CSS 可见性影响）
    await expect(page.locator('.ai-window-list')).toHaveCount(1)
    await expect(page.locator('.awl-new-workspace')).toHaveCount(1)
  })

  test('编辑器（CodeMirror）可见', async ({ page }) => {
    await expect(page.locator('.cm-content')).toBeVisible({ timeout: 10_000 })
  })

  test('侧栏 tab 可切换（文件树/工作日志/知识库/终端/视频生成）', async ({ page }) => {
    // [spec-align-v2] 「变更列表」tab 已在 SidePane.vue 中注释掉，当前可见 tab 共 5 个。
    //   [WHY] 原断言 .tree .list 依赖文件树有数据；空工作区走 empty 分支 ⇒ 恒红。
    //   改为断言 tab 容器切换后的面板根（.side-tree 由 v-show 控制，恒挂载）
    const tabs = page.locator('.side-tab')
    await expect(tabs).toHaveCount(5)
    await tabs.nth(0).click()
    await expect(page.locator('.side-tree')).toBeVisible({ timeout: 5000 })
  })

  test('运行按钮可见', async ({ page }) => {
    await expect(page.locator('.primary-btn.head-run').first()).toBeVisible({ timeout: 5000 })
  })
})
