// AIRUNNER-BATCH22-4-VITEST-CFG: 测试集中到 client/test（batch22 迁移后）
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'client/test/**/*.node-test.ts',
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
    globals: false,
    isolate: true,
  },
})
