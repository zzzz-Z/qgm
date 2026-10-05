// AIRUNNER-BATCH26-3-INCLUDE-TEST-TS: include 同时覆盖 .node-test.ts 与 .test.ts
import { defineConfig } from 'vitest/config'
// [vue-sfc-in-vitest-v1] 组件级测试需编译 .vue；本插件只影响 SFC 转换，不改变 node 环境
import vue from '@vitejs/plugin-vue'

// HOST-POWER-LIMIT: 宿主是 16 核 i9-9880H，且 96W 适配器实际只协商到 60W（SMC 限频，
// CPU_Speed_Limit 常年在 41~52）。vitest 默认按核数开 worker，满载时互相抢 CPU，
// 会让 hclc-guard / workspace-guard 的 5s testTimeout 因争抢误报（空闲复跑即绿）。
// 默认限 4 并发；需要全速（CI 或供电充足的机器）时：`VITEST_MAX_WORKERS=0 pnpm test:unit`。
const MAX_WORKERS = process.env.VITEST_MAX_WORKERS === '0'
  ? undefined
  : Number(process.env.VITEST_MAX_WORKERS) || 4

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
    include: [
      'packages/**/*.node-test.ts',
      'packages/**/*.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'packages/client/e2e/**',
      'e2e/**',
      '**/*.spec.ts',
      'packages/client/playwright-report/**',
      'packages/client/test-results/**',
    ],
    // AIRUNNER-BATCH31-COVERAGE: 需先安装 @vitest/coverage-v8（pnpm add -D @vitest/coverage-v8）
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['packages/client/**/*.{ts,vue}', 'packages/core/src/**/*.ts'],
      exclude: ['**/*.d.ts', '**/node_modules/**', 'test/**', '**/*.test.ts', '**/*.node-test.ts'],
    },
    globals: false,
    isolate: true,
    maxWorkers: MAX_WORKERS,
  },
})
