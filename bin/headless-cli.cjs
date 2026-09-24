#!/usr/bin/env node
// [headless-cli-v2] 自包含：不依赖 dist/TS 加载器；直接调 playwright 跑 cssom/screenshot
// 用法: node bin/headless-cli.cjs cssom <url> <selector>
//      node bin/headless-cli.cjs screenshot <url> <selector> <outPath> [mask1,mask2]

'use strict'
const fs = require('node:fs')
const path = require('node:path')

async function loadPw() {
  try { return await import('playwright') } catch { return null }
}

async function cmdCssom(url, selector) {
  const pw = await loadPw()
  if (!pw) throw new Error('playwright 未安装')
  const browser = await pw.chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
      const client = await page.context().newCDPSession(page)
      await client.send('DOM.enable')
      await client.send('CSS.enable')
      const doc = await client.send('DOM.getDocument')
      const q = await client.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector })
      if (!q.nodeId) throw new Error(`选择器未命中: ${selector}`)
      const matched = await client.send('CSS.getMatchedStylesForNode', { nodeId: q.nodeId })
      const rules = []
      for (const m of (matched.matchedCSSRules || [])) {
        const rule = m.rule
        const origin = rule.styleSheetId ? (`styleSheet:${rule.styleSheetId}`) : (rule.origin || 'unknown')
        const sel = rule.selectorList && rule.selectorList.text ? rule.selectorList.text : ''
        for (const p of (rule.style && rule.style.cssProperties ? rule.style.cssProperties : [])) {
          if (p.disabled) continue
          rules.push({ selector: sel, property: p.name, value: p.value, origin, line: 0 })
        }
      }
      const inline = (matched.inlineStyle && matched.inlineStyle.cssProperties ? matched.inlineStyle.cssProperties : []).map(p => ({ property: p.name, value: p.value }))
      return { matched: rules, inline }
    } finally {
      await page.close()
    }
  } finally {
    await browser.close()
  }
}

async function cmdScreenshot(url, selector, outPath, maskRaw) {
  const pw = await loadPw()
  if (!pw) throw new Error('playwright 未安装')
  const browser = await pw.chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
      const loc = page.locator(selector)
      if (await loc.count() === 0) throw new Error(`选择器未命中: ${selector}`)
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
      const mask = maskRaw ? maskRaw.split(',').filter(Boolean).map(s => page.locator(s)) : []
      await loc.first().screenshot({ path: outPath, mask, animations: 'disabled' })
      const bytes = fs.statSync(outPath).size
      return { ok: true, path: outPath, bytes }
    } finally {
      await page.close()
    }
  } finally {
    await browser.close()
  }
}

async function main() {
  const args = process.argv.slice(2)
  const cmd = args[0]
  if (cmd === 'cssom') {
    const [url, selector] = args.slice(1)
    if (!url || !selector) throw new Error('usage: cssom <url> <selector>')
    const r = await cmdCssom(url, selector)
    process.stdout.write(JSON.stringify({ ok: true, result: r }))
    return
  }
  if (cmd === 'screenshot') {
    const [url, selector, outPath, maskRaw] = args.slice(1)
    if (!url || !selector || !outPath) throw new Error('usage: screenshot <url> <selector> <outPath> [mask1,mask2]')
    const r = await cmdScreenshot(url, selector, outPath, maskRaw)
    process.stdout.write(JSON.stringify({ ok: true, result: r }))
    return
  }
  // [headless-cli-diff-v1]
  if (cmd === 'diff') {
    const [baseline, current, diffOut] = args.slice(1)
    if (!baseline || !current || !diffOut) throw new Error('usage: diff <baseline.png> <current.png> <diffOut.png>')
    const pm = (await import('pixelmatch')).default
    const { PNG } = await import('pngjs')
    const a = PNG.sync.read(fs.readFileSync(baseline))
    const b = PNG.sync.read(fs.readFileSync(current))
    if (a.width !== b.width || a.height !== b.height) {
      process.stdout.write(JSON.stringify({ ok: false, error: `size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}` }))
      return
    }
    const { width, height } = a
    const diff = new PNG({ width, height })
    const diffPixels = pm(a.data, b.data, diff.data, width, height, { threshold: 0.1 })
    const totalPixels = width * height
    const diffPercent = totalPixels ? diffPixels / totalPixels : 0
    let status = 'identical'
    if (diffPercent > 0.05) status = 'major'
    else if (diffPercent > 0.005) status = 'minor'
    if (status !== 'identical') {
      fs.mkdirSync(path.dirname(diffOut), { recursive: true })
      fs.writeFileSync(diffOut, PNG.sync.write(diff))
    }
    process.stdout.write(JSON.stringify({ ok: true, result: { status, diffPercent, diffPixels, totalPixels, width, height, paths: { baseline, current, diff: diffOut } } }))
    return
  }
  throw new Error(`unknown cmd: ${cmd}`)
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 300) }))
  process.exit(1)
})
