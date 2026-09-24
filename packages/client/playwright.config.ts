import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI
    ? [['list'], ['html', { outputFolder: 'e2e/playwright-report', open: 'never' }]]
    : 'list',
  use: {
    baseURL: 'http://localhost:5174/__ai/',
    trace: 'retain-on-failure',
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'pnpm web:dev',
    cwd: '..',
    url: 'http://localhost:5174/__ai/',
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
