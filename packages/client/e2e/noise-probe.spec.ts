import { expect, test } from '@playwright/test'

if (process.env.NODE_TEST_CONTEXT) { process.exit(0) }

test('dump real event-stream noise', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('.terminal', { timeout: 10_000 })
  await page.waitForTimeout(1500)
  const data = await page.evaluate(() => {
    const raw = localStorage.getItem('__ai_event_log')
    const arr = raw ? JSON.parse(raw) : []
    const kinds: Record<string, number> = {}
    for (const e of arr) kinds[e.kind] = (kinds[e.kind] || 0) + 1
    const F = String.fromCharCode(96).repeat(3)
    let plainWithScript = 0
    const samples: string[] = []
    for (const e of arr) {
      if (e.kind === 'ai:plain' || e.kind === 'ai:multi') {
        const t = String((e.payload && e.payload.text) || '')
        if (/@desc/.test(t) || t.includes('#!') || t.includes(F)) {
          plainWithScript++
          if (samples.length < 3) samples.push(t.slice(0, 200))
        }
      }
    }
    const cards = Array.from(document.querySelectorAll('.text-card, .script-card, .done-summary')).map(e => ({ c: e.className.split(' ')[0], t: (e.textContent || '').slice(0, 60) }))
    return { total: arr.length, kinds, plainWithScript, samples, cards }
  })
  console.log(`[noise] ${JSON.stringify(data).slice(0, 4000)}`)
  expect(true).toBe(true)
})
