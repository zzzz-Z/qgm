import { expect, test } from '@playwright/test'

// 若被 node --test 拾取（NODE_TEST_CONTEXT 由 node 子进程自动设置），立即退出
// 与 client/e2e/headless-ws.spec.ts 保持同一策略
if (process.env.NODE_TEST_CONTEXT) {
  process.exit(0)
}

// [P5-2] /__ai/diff-from-baseline 端点契约测试
// 前提：dev server 已在 baseURL 运行（playwright.config.ts webServer 提供）

test('/__ai/diff-from-baseline 缺 baselineRunId 返回 400', async ({ request }) => {
  const r = await request.post('/__ai/diff-from-baseline', { data: {} })
  expect(r.status()).toBe(400)
  const j = await r.json()
  expect(j.error).toMatch(/baselineRunId/)
})

test('/__ai/diff-from-baseline 未知 baselineRunId 返回 404', async ({ request }) => {
  const r = await request.post('/__ai/diff-from-baseline', {
    data: { baselineRunId: `nonexistent-${Date.now()}` },
  })
  expect(r.status()).toBe(404)
  const j = await r.json()
  expect(j.error).toMatch(/基准|记录/)
})

test('/__ai/diff-from-baseline 有效 runId 返回结构完整', async ({ request }) => {
  // 1) 先跑一个只读脚本拿 runId
  // [CONSTRAINT] /run 有脚本头契约前置校验（ai-guard scanScriptHead），缺 @desc/@why 会 400
  const script = [
    '#!/usr/bin/env node',
    '// @desc baseline-seed 冒烟种子',
    '// @why e2e diff-from-baseline 需要一个真实 runId 作为基准',
    'log.info("baseline-seed")',
    'process.exit(0)',
  ].join('\n')
  const runRes = await request.post('/__ai/run', { data: { script } })
  expect(runRes.status()).toBe(200)

  // NDJSON 流里取 summary 帧的 runId
  const body = await runRes.text()
  const lines = body.split('\n').filter(Boolean)
  let runId = ''
  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      if (obj.type === 'summary' && obj.runId) {
        runId = String(obj.runId)
        break
      }
    } catch { /* 非 JSON 行跳过 */ }
  }
  expect(runId).not.toBe('')

  // 2) 用该 runId 做 baseline 对比
  const diffRes = await request.post('/__ai/diff-from-baseline', {
    data: { baselineRunId: runId },
  })
  expect(diffRes.status()).toBe(200)
  const j = await diffRes.json()
  expect(j.baselineRunId).toBe(runId)
  expect(Array.isArray(j.changes)).toBe(true)
})
