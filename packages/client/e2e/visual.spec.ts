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
 * [worklog-fixture-v1] 03 用例的固定数据：拦截 /git/worklog、/git/diff、/git/head 返回确定内容。
 * [WHY] 原做法是遮掉整片 `.wl-scroll`（内容 = 当前 git 工作区状态，实测 22 → 27 必红）；
 *   但整片遮罩使「文件列表 / 分组头 / diff 展开区」的任何 UI 改动都不进判据 —— 视觉回归在该面板上真空。
 *   改为 route mock 后内容确定 ⇒ 撤掉宽遮罩，整片滚动区真正进基线。
 * [CONSTRAINT] 必须比 `03` 里点击 worklog tab **更早**注册：WorklogPane 是切 tab 才挂载，
 *   挂载即 fetch，route 晚于挂载则拦不到。
 */
const WORKLOG_FIXTURE_FILES = [
  { path: 'packages/core/src/git.ts', status: 'modified', added: 12, removed: 4 },
  { path: 'packages/client/components/panels/WorklogPane.vue', status: 'modified', added: 30, removed: 8 },
  { path: 'packages/client/components/panels/worklog-pane.scss', status: 'added', added: 60, removed: 0 },
]
const WORKLOG_FIXTURE_HISTORY = [
  'ee7940a chore: 批量收口多工单改动',
  '48bd81e 1',
  '0782b78 chore(memory): 记录提交与未完成盘点',
]
const WORKLOG_FIXTURE_DIFF = [
  'diff --git a/packages/core/src/git.ts b/packages/core/src/git.ts',
  '--- a/packages/core/src/git.ts',
  '+++ b/packages/core/src/git.ts',
  '@@ -1,3 +1,4 @@',
  ' export async function gitHead() {',
  '-  return null',
  '+  return run(\'git\', [\'rev-parse\', \'HEAD\'])',
  ' }',
].join('\n')

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
      // [worklog-fixture-v1] 三个 git 端点全部 mock：内容确定化 ⇒ 滚动区可进基线（撤掉宽遮罩）
      await page.route('**/__ai/git/worklog', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          since: 'HEAD',
          until: '',
          generatedAt: 0,
          files: WORKLOG_FIXTURE_FILES,
          history: WORKLOG_FIXTURE_HISTORY,
          stat: '',
          markdown: '',
        }),
      }))
      await page.route('**/__ai/git/diff', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, diff: WORKLOG_FIXTURE_DIFF, filesCount: 3 }),
      }))
      await page.route('**/__ai/git/head', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, head: 'ee7940a8c0de' }),
      }))
      await page.locator(`.side-tab[aria-label="${TAB_WORKLOG}"]`).click()
      await expect(page.locator('.side-worklog')).toBeVisible()
      // 等骨架退场、固定数据行出现，否则截到 loading 态
      await expect(page.locator('.wl-item-head').first()).toBeVisible({ timeout: 10_000 })
      await page.waitForTimeout(300)
      await expect(page).toHaveScreenshot(`03-worklog-${theme}.png`, {
        mask: MASK_SELECTORS.map(s => page.locator(s)),
        animations: 'disabled',
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

    test(`06 脚本执行区 · ${theme}`, async ({ page }) => {
      // [script-card-baseline-v1] 06 视图：seed 一条 run:start 事件让 ScriptCard 真实挂载。
      // [WHY] 前三轮尝试（localStorage seed / DEV 桥 / addInitScript+reload）全失败，根因是
      //   「组件不在默认渲染路径」。本用例改为 seed event-stream（TerminalPane 的 timelineItems 数据源），
      //   使 .script-card 由真实数据驱动挂载 —— 走真实渲染路径，非绕过。
      // [CONSTRAINT] 必须在 goto 之后再次 addInitScript + reload：beforeEach 已 goto，注入晚于首帧。
      //   addInitScript 在每次导航前执行，故 reload 后 loadEvents() 能读到 seed。
      await page.addInitScript(() => {
        try {
          const ev = {
            id: 1,
            ts: 1700000000000,
            kind: 'run:start',
            round: 1,
            summary: '执行脚本',
            payload: {
              desc: '示例脚本：生成产物',
              why: '像素基线守护用例',
              lang: 'js',
              phase: 'done',
              exit: 0,
              changeCount: 2,
              updateKey: 'baseline-card-1',
            },
          }
          localStorage.setItem('__ai_event_log', JSON.stringify([ev]))
        } catch { /* ignore */ }
      })
      await page.reload()
      await settle(page)
      await expect(page.locator('.script-card').first()).toBeVisible({ timeout: 10_000 })
      // [script-card-viewport-v1] 卡片可能在滚动区下方 —— 不滚到视口，截图捕获不到它，
      //   样式变异就不会让基线变红（判据真空）。scrollIntoViewIfNeeded 后卡片进入视口。
      await page.locator('.script-card').first().scrollIntoViewIfNeeded()
      await page.waitForTimeout(300)
      await expect(page).toHaveScreenshot(`06-script-${theme}.png`, {
        mask: MASK_SELECTORS.map(s => page.locator(s)),
        // [anim-v1] .phase-icon-spin 是 infinite 动画，默认等动画结束会永久挂起
        animations: 'disabled',
      })
    })
  })
}
