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
    globals: false,
    isolate: true,
  },
})
