import { expect, test } from '@playwright/test'

if (process.env.NODE_TEST_CONTEXT) { process.exit(0) }

test.describe('V9 render probe', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      ;(window as unknown as { __AI_RENDER_PROBE__?: boolean }).__AI_RENDER_PROBE__ = true
    })
    await page.goto('/')
    await page.waitForSelector('.hdr', { timeout: 10_000 })
    await page.waitForSelector('.terminal', { timeout: 10_000 })
  })

  // [ui-p2c-render-probe-e2e-v1] 判据①：500 事件 + 1 新事件 → updated 卡数 ≤ 3
  test('single event re-renders ≤ 3 cards after 500 events', async ({ page }) => {
    await page.evaluate(() => {
      const w = window as unknown as {
        __AI_EVENT_HOOKS__?: { clear: () => void }
        __AI_RENDER_PROBE_READ__?: { clear: () => void }
      }
      w.__AI_EVENT_HOOKS__?.clear()
      w.__AI_RENDER_PROBE_READ__?.clear()
    })

    await page.evaluate((n: number) => {
      const w = window as unknown as {
        __AI_EVENT_HOOKS__?: { emit: (k: string, s: string, o?: Record<string, unknown>) => void }
      }
      const emit = w.__AI_EVENT_HOOKS__?.emit
      if (!emit) throw new Error('__AI_EVENT_HOOKS__ missing')
      for (let i = 0; i < n; i++) emit('ai:plain', `seed-${i}`, { payload: { text: `seed ${i}` } })
    }, 500)
    await page.waitForTimeout(500)

    await page.evaluate(() => {
      const w = window as unknown as { __AI_RENDER_PROBE_READ__?: { clear: () => void } }
      w.__AI_RENDER_PROBE_READ__?.clear()
    })
    await page.waitForTimeout(150)

    await page.evaluate(() => {
      const w = window as unknown as {
        __AI_EVENT_HOOKS__?: { emit: (k: string, s: string, o?: Record<string, unknown>) => void }
      }
      w.__AI_EVENT_HOOKS__?.emit('ai:plain', 'probe-trigger', { payload: { text: 'trigger' } })
    })
    await page.waitForTimeout(400)

    // [ui-p2c-probe-anticheat-v1] 同时读 log 与 updated，抗「探针哑火 → 空数组假通过」
    const { updated, totalLog } = await page.evaluate(() => {
      const w = window as unknown as { __AI_RENDER_PROBE_READ__?: { get: () => Array<{ key: string, phase: string }> } }
      const log = w.__AI_RENDER_PROBE_READ__?.get() ?? []
      const set = new Set<string>()
      for (const e of log) { if (e.phase === 'update') set.add(e.key) }
      return { updated: [...set], totalLog: log.length }
    })
    console.log(`[probe] totalLog=${totalLog} updated=${updated.length} keys=${JSON.stringify(updated.slice(0, 6))}`)

    // 抗假阳性：探针必须真的记录了内容（mount 至少打点一次）
    expect(totalLog).toBeGreaterThan(0)
    // 判据：单事件到达后只有新增/变更的卡更新（新卡 mount 不计）
    expect(updated.length).toBeLessThanOrEqual(3)
  })
})
