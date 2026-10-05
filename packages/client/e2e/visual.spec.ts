// [ui-p2b-visual-v1] V7 视觉回归基线：5 视图 × 2 主题 = 10 张截图。
// [WHY] 计划要求「改任意样式后至少一张基线变红」；这里用 toHaveScreenshot 走 Playwright 内置像素对比。
// [CONSTRAINT] 基线由复核方执行 `pnpm test:e2e --update-snapshots` 生成/重建，本 spec 不自带。
// [visual-invariant-v1] 三条已实测踩过的坑（2026-10-05 复核）：
//   1. 主题必须在 **goto 之前** 经 addInitScript 写进 localStorage，让应用自己带主题启动。
//      旧写法是 goto 之后直接改 `data-theme` 属性 —— 那是「绕过应用手改 DOM」，测不到主题接线；
//      也正是旧基线 dark 与 light 逐像素相同的成因（10 张图只有 4 个唯一哈希）。
//   2. 每张截图前断言 `html[data-theme]` 真的是目标主题。没有这条，主题链路坏掉时
//      10 张图会静默退化成 5 张，而用例全绿（这正是缺陷能潜伏很久的原因）。
//   3. 遮罩选择器必须逐条与源码对齐 —— 旧列表里 `.hms` / `.term-body` / `.worklog-time`
//      早已在源码中不存在（实测运行时命中 0），遮罩静默失效 ⇒ 基线抖动风险回来。
//      由 visual-spec-guard.node-test.ts 双向守卫（spec ↔ 源码）。
// [CONSTRAINT] 视图一律用 aria-label 定位，**不用 `.nth(i)`**：旧写法 `.side-tab` 的 nth(0)
//   恰好就是默认 tab，于是「01 首屏」与「02 文件树」逐像素相同（实测），号称 5 视图实际只覆盖 4 个。
import { expect, test } from '@playwright/test'

if (process.env.NODE_TEST_CONTEXT) { process.exit(0) }

/** 稳定等待：等首帧骨架退场、字体加载完成 */
async function settle(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForSelector('.hdr', { timeout: 10_000 })
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => document.fonts && document.fonts.ready)
  await page.waitForTimeout(200)
}

/** 动态区域遮罩：编辑器内容 / 时间戳 / 时长 / toast / tooltip —— 每条都必须真实存在于源码 */
const MASK_SELECTORS = [
  '.cm-content',
  '.toast-host',
  '.tt-host',
  '.script-card-time',
  '.round-divider-time',
  '.tp-time',
  '.wait-elapsed',
]

/** 侧栏 tab 的 aria-label（与 components/panels/SidePane.vue 的按钮一致） */
const TAB_TREE = '文件树'
const TAB_CHANGES = '变更列表'
const TAB_WORKLOG = '工作日志'

/**
 * [volatile-worklog-mask-v1] **只在 03 用**的额外遮罩：`.wl-scroll`（WorklogPane 的变更文件清单）。
 * [WHY] 实测（2026-10-05 第二轮）：03 工作日志的两条主题基线在重跑时**确定性**失败
 *   （6503 像素 / ratio 0.01，重试三次数字完全相同 ⇒ 不是抖动，是内容真变了）。
 *   根因：WorklogPane 是「VSCode 源码管理风格」面板，其文件清单来自 `/__ai/git/worklog`
 *   ⇒ **内容 = 当前 git 工作区状态**。基线拍摄时是 22 个变更，重跑时 27 个（本轮新增了
 *   `AGENTS.md` 改动等）⇒ 凡是会改 `git status` 的开发活动都会把这条基线打红，
 *   而且是**每次都红**——视觉回归就退化成「每次都要 --update-snapshots」的噪音源。
 * [CONSTRAINT] 只遮清单、**不遮整个窗格**：`.wl-commit`（提交框 / 生成按钮）是稳定 chrome，
 *   仍留在基线里，03 才有回归价值。由 visual-spec-guard 的对应用例守卫
 *   （含「03 用例体必须真的引用 MASK_VOLATILE_WORKLOG」，防有人改回只含 MASK_SELECTORS）。
 */
const MASK_VOLATILE_WORKLOG = ['.wl-scroll']

for (const theme of ['dark', 'light'] as const) {
  test.describe(`视觉基线 · ${theme}`, () => {
    test.beforeEach(async ({ page }) => {
      // [visual-invariant-v1] 必须在 goto 之前注入：让应用启动时就读到该主题
      await page.addInitScript((t) => {
        try { localStorage.setItem('__ai_theme', t) } catch { /* ignore */ }
      }, theme)
      await page.goto('/')
      await settle(page)
      // 主题接线自检：属性不是目标值 ⇒ 后续每张图都是错的，直接判失败
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    })

    test(`01 首屏 · ${theme}`, async ({ page }) => {
      // 默认激活的就是文件树 tab —— 这里显式断言，避免「首屏等于文件树」变成隐性假设
      await expect(page.locator('.side-tab-active')).toHaveAttribute('aria-label', TAB_TREE)
      await expect(page).toHaveScreenshot(`01-home-${theme}.png`, {
        fullPage: false,
        mask: MASK_SELECTORS.map(s => page.locator(s)),
      })
    })

    test(`02 变更面板 · ${theme}`, async ({ page }) => {
      await page.locator(`.side-tab[aria-label="${TAB_CHANGES}"]`).click()
      await expect(page.locator('.side-changes')).toBeVisible()
      await page.waitForTimeout(300)
      await expect(page).toHaveScreenshot(`02-changes-${theme}.png`, {
        mask: MASK_SELECTORS.map(s => page.locator(s)),
      })
    })

    test(`03 工作日志 · ${theme}`, async ({ page }) => {
      await page.locator(`.side-tab[aria-label="${TAB_WORKLOG}"]`).click()
      await expect(page.locator('.side-worklog')).toBeVisible()
      await page.waitForTimeout(500)
      await expect(page).toHaveScreenshot(`03-worklog-${theme}.png`, {
        mask: [...MASK_SELECTORS, ...MASK_VOLATILE_WORKLOG].map(s => page.locator(s)),
      })
    })

    test(`04 编辑器聚焦 · ${theme}`, async ({ page }) => {
      await page.locator('.cm-content').click()
      await expect(page.locator('.cm-content')).toBeFocused()
      await page.waitForTimeout(200)
      await expect(page).toHaveScreenshot(`04-editor-${theme}.png`, {
        mask: MASK_SELECTORS.map(s => page.locator(s)),
      })
    })

    test(`05 侧栏收起 · ${theme}`, async ({ page }) => {
      await page.locator('.side-collapse-btn').click()
      await expect(page.locator('.pane-side')).toHaveClass(/is-collapsed/)
      await page.waitForTimeout(300)
      await expect(page).toHaveScreenshot(`05-collapsed-${theme}.png`, {
        mask: MASK_SELECTORS.map(s => page.locator(s)),
      })
    })
  })
}
