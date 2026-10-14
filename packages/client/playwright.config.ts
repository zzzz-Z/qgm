import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  // [e2e-output-dir-v1] 产物统一落仓库根 .ai-runner/tmp（WO-20261007-03 段二）：
  //   相对路径产物会落到 packages/client/ 污染包目录（实测 2026-10-07 出现 packages/client/.ai-runner/）。
  outputDir: '../../.ai-runner/tmp/e2e-output',
  // [e2e-timeout-v1] 180s：beforeAll 钩子**同样**受本项封顶（实测：30s 下钩子内睡 45s 直接失败），
  //   而 headless-ws.spec.ts 的 beforeAll 要等 air-server 冷启动 —— 源码比 dist 新时它会先跑一次全量构建。
  // [CONSTRAINT] spec 内的自设预算必须小于本值，好让失败信息是「服务未就绪」而不是笼统的 hook timeout。
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI
    ? [['list'], ['html', { outputFolder: 'e2e/playwright-report', open: 'never' }]]
    : 'list',
  // [snapshot-no-platform-v1] 默认模板含 {-snapshotSuffix}（= process.platform），
  //   基线名会被钉成 *-chromium-darwin.png —— 换平台后 Playwright 找不到对应文件即判失败，
  //   表象是「像素差异」而实为「快照名不匹配」，误导排查方向。这里显式去掉该段。
  // [CHANGE-IMPACT] 既有基线的文件名需从 *-chromium-darwin.png 改为 *-chromium.png
  //   （用 --update-snapshots 重建即可，见 visual.spec.ts 头注释）。
  // [CONSTRAINT] 去掉平台段不等于「跨平台基线通用」：Linux 的字体/抗锯齿与 macOS 不同，
  //   真要在多平台跑视觉用例，须为各平台单独提交基线（或另设 snapshotDir）。
  snapshotPathTemplate: '{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}{-projectName}{ext}',
  use: {
    baseURL: 'http://localhost:5274/__ai/',
    trace: 'retain-on-failure',
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    // [fix-webserver-cmd] 根 package.json 实际脚本为 dev:web；原 web:dev 从不存在，
    // 仅因 reuseExistingServer 复用已运行实例而长期未暴露
    command: 'pnpm dev:web',
    // [fix-webserver-cwd-v1] cwd 按**配置文件目录**解析（Playwright 源码：path.resolve(configDir, cwd)），
    //   本文件在 packages/client/ ⇒ '..' = packages/，那里没有 dev:web 脚本。
    //   正解是回到仓库根（packages/client/../..）。
    cwd: '../..',
    // [e2e-webserver-url-v1] 探活前端根路径即可；/__ai/* 经 proxy 转发后端，
    //   后端由具体 spec 的 beforeAll 独立拉起，webServer 探活不应依赖代理后端是否就绪
    url: 'http://localhost:5274/',
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
