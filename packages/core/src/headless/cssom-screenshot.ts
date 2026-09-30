// @env node
// [cssom-screenshot-v1] PLAN 6.2 首批能力：cssom（样式来源定位）+ screenshot（元素级截图）
import fs from 'node:fs'
import path from 'node:path'
import { getBrowser } from './smoke.js'

/** CSSOM 查询规则：选择器表达式与匹配策略 */
export interface CssomRule {
  selector: string
  property: string
  value: string
  origin: string
  line: number
}

/** CSSOM 查询结果：命中的规则、来源与优先级 */
export interface CssomResult {
  matched: CssomRule[]
  inline: Array<{ property: string, value: string }>
}

interface CdpProperty { name: string, value: string, disabled?: boolean }
interface CdpMatchedRule {
  rule: {
    selectorList: { text: string }
    style: { cssProperties: CdpProperty[] }
    styleSheetId?: string
    origin?: string
  }
}
interface CdpMatchedResponse {
  matchedCSSRules?: CdpMatchedRule[]
  inlineStyle?: { cssProperties: CdpProperty[] }
}

/** 截图结果：输出文件路径、图像尺寸、耗时 */
export interface ScreenshotResult {
  ok: boolean
  path: string
  bytes: number
  error?: string
}

/**
 * 用 CDP 的 CSS.getMatchedStylesForNode 拿「哪条规则生效、来自哪张样式表」。
 * 替代 SYSTEM.md 第八章的 DevTools 人肉排查。
 */

/**
 * 通过 CDP 抓取指定选择器命中元素的匹配 CSS 规则
 * [WHY] CDP 的 getMatchedStylesForNode 能拿到 computed 与 inherited 规则，
 * 比 JS 遍历 document.styleSheets 更完整（含伪类 / 媒体查询）
 * [CONSTRAINT] 选择器未命中会抛错；调用方负责 catch 并降级为截图模式
 * [CHANGE-IMPACT] 返回结构被 browser.cssom 工具消费，改动会影响 AI 侧的诊断输出
 * @param url 目标页面 URL
 * @param selector CSS 选择器
 */
export async function cssom(url: string, selector: string): Promise<CssomResult> {
  const browser = await getBrowser()
  const page = await browser.newPage()
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 })
    const client = await page.context().newCDPSession(page)
    await client.send('DOM.enable')
    await client.send('CSS.enable')
    const doc = await client.send('DOM.getDocument') as { root: { nodeId: number } }
    const q = await client.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector }) as { nodeId: number }
    if (!q.nodeId) throw new Error(`选择器未命中: ${selector}`)
    const matched = await client.send('CSS.getMatchedStylesForNode', { nodeId: q.nodeId }) as CdpMatchedResponse
    const rules: CssomRule[] = []
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
}

/**
 * 元素级截图，支持 mask（屏蔽动态内容）与动画冻结。
 * 返回结构化结果，供「改完 UI 变没变」对比使用。
 */
export async function screenshot(
  url: string,
  selector: string,
  outPath: string,
  opts?: { mask?: string[] },
): Promise<ScreenshotResult> {
  try {
    const browser = await getBrowser()
    const page = await browser.newPage()
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 })
      const loc = page.locator(selector)
      if (await loc.count() === 0) throw new Error(`选择器未命中: ${selector}`)
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
      const maskLocators = (opts && opts.mask ? opts.mask : []).map(s => page.locator(s))
      await loc.first().screenshot({ path: outPath, mask: maskLocators, animations: 'disabled' })
      const bytes = fs.statSync(outPath).size
      return { ok: true, path: outPath, bytes }
    } finally {
      await page.close()
    }
  } catch (e) {
    return { ok: false, path: outPath, bytes: 0, error: String(e).slice(0, 200) }
  }
}
