// AIRUNNER-BATCH26-3-INCLUDE-TEST-TS: include 同时覆盖 .node-test.ts 与 .test.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'test/**/*.node-test.ts',
      'test/**/*.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'client/e2e/**',
      'e2e/**',
      '**/*.spec.ts',
      'client/playwright-report/**',
      'client/test-results/**',
    ],
    // AIRUNNER-BATCH31-COVERAGE: 需先安装 @vitest/coverage-v8（pnpm add -D @vitest/coverage-v8）
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['client/**/*.{ts,vue}', 'src/**/*.ts'],
      exclude: ['**/*.d.ts', '**/node_modules/**', 'test/**', '**/*.test.ts', '**/*.node-test.ts'],
    },
    globals: false,
    isolate: true,
  },
})
