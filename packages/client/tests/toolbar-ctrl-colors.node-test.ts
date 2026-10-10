// [ctrl-btn-semantic-color-v2] 循环控制键的配色守卫（2026-10-09）。
//
// 为什么值得单独守：这个按钮的配色曾经是「一个颜色走天下」——
// 运行中与已暂停共用硬编码 #f0abfc 粉紫，于是同时踩两个坑：
//   ① 语义缺席：粉紫既不说「暂停」也不说「恢复」，两个状态只能靠图标区分；
//   ② 亮色主题下对比度 1.65:1（白底上几乎不可见），属可用性缺陷。
// 配色一改就容易「悄悄改回去」，所以这里把三件事钉死：
//   ① 三态 → 三种**不同**的语义令牌（开始=蓝 / 暂停=琥珀 / 恢复=绿）；
//   ② 这三条规则里不许再出现自造颜色（复用既有语义变量）；
//   ③ 令牌在暗/亮两套里对实际背景的对比度 ≥ 4.5:1 —— 用真算，不是靠注释声称。
//
// 注：本文件所有断言都跑在**剥掉注释**的源码上。否则「注释里提到旧色 #f0abfc」
// 就会被误判成「旧色又回来了」，判据变成对文档语气敏感的空断言。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { it } from 'vitest'

const ROOT = process.cwd()
const TOOLBAR = 'packages/client/components/script/ScriptToolbar.vue'
const STYLE_CSS = 'packages/client/style.css'
const FILE_TREE_SCSS = 'packages/client/components/panels/file-tree.scss'
const E2E = 'packages/client/e2e/ai-runner.spec.ts'
/** 亮色主题块的选择器（写成常量，避免在字符串里嵌引号） */
const LIGHT_THEME_SELECTOR = '[data-theme=\'light\']'

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

/** 剥掉 HTML 与 CSS 注释（判据只针对可执行代码，不针对文档文字） */
function stripComments(src: string): string {
  return src.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

/** 截出 `selector { … }` 的规则体（这些规则内无嵌套，故首个 `}` 即块尾） */
function ruleBody(src: string, selector: string): string {
  const i = src.indexOf(`${selector} {`)
  assert.ok(i >= 0, `找不到规则 ${selector}`)
  const open = src.indexOf('{', i)
  const close = src.indexOf('}', open)
  assert.ok(close > open, `${selector} 规则体未闭合`)
  return src.slice(open + 1, close)
}

/** 去掉 `var(…)` 内的回退值后再找自造颜色：回退值是降级兜底，不算「配色来源」 */
function withoutFallbacks(body: string): string {
  return body.replace(/var\([^)]*\)/g, 'var(--tok)')
}

/** 纯白/纯黑是通用前景底色，不属于「自造色」（.takeover 的白字靠它） */
function inventedHexes(body: string): string[] {
  const found = withoutFallbacks(body).match(/#[0-9a-f]{3,8}\b/gi) || []
  return found.filter(h => !/^#(?:fff|ffffff|000|000000)$/i.test(h))
}

// ── ① 三态 → 三种不同的语义令牌 ────────────────────────────────────────────

it('三态配色各归其位，且三者互不相同：开始=--primary、暂停=--warning、恢复=--success', () => {
  const src = stripComments(read(TOOLBAR))
  const pick = (sel: string) => ruleBody(src, sel).match(/var\((--[\w-]+)/)?.[1]
  const takeover = pick('.tpl-bar button.primary-btn.takeover')
  const pause = pick('.tpl-bar button.primary-btn.pause')
  const resume = pick('.tpl-bar button.primary-btn.resume')

  // ① 语义归位：每个状态必须落在它该用的令牌上（「开始=发起」用主色、「暂停=按住」用警示、「恢复=继续」用成功色）
  assert.equal(takeover, '--primary', `「开始」态应绑 --primary，实际 ${takeover}`)
  assert.equal(pause, '--warning', `「暂停」态应绑 --warning，实际 ${pause}`)
  assert.equal(resume, '--success', `「恢复」态应绑 --success，实际 ${resume}`)
  // ② 三者互不相同：否则又会退回「一个颜色走天下」——两个运行态只能靠图标区分
  assert.equal(new Set([takeover, pause, resume]).size, 3, `三态颜色必须互不相同，实际 = ${[takeover, pause, resume].join(' / ')}`)
})

it('三态规则里不得出现自造颜色（防止旧粉紫或任意硬编码回归）', () => {
  const src = stripComments(read(TOOLBAR))
  for (const sel of ['.tpl-bar button.primary-btn.takeover', '.tpl-bar button.primary-btn.pause', '.tpl-bar button.primary-btn.resume']) {
    const bad = inventedHexes(ruleBody(src, sel))
    assert.deepEqual(bad, [], `${sel} 里出现硬编码颜色 ${bad.join(', ')}（应改用语义令牌）`)
  }
  // 旧粉紫的三种写法，在（已剥注释的）代码里全仓禁绝
  assert.doesNotMatch(src, /#f0abfc|#f5c6ff|rgb\(240 171 252/i, '旧的粉紫配色又回到代码里了（语义上说不通且亮色不可读）')
})

// ── ② 模板接线：状态 → 类名，且 e2e 依赖的 .head-run 不能丢 ─────────────────

it('模板按 loopPaused 切换 pause / resume，且已无 .stop 残留', () => {
  const src = stripComments(read(TOOLBAR))
  assert.match(src, /class="primary-btn head-run"/, '循环控制键的基类变了')
  assert.match(src, /['"]?pause['"]?\s*:\s*!loopPaused/, '未暂停时未挂 .pause 类 ⇒ 运行态拿不到琥珀配色')
  assert.match(src, /['"]?resume['"]?\s*:\s*loopPaused/, '暂停时未挂 .resume 类 ⇒ 恢复态拿不到绿配色')
  assert.doesNotMatch(src, /['"]stop['"]|primary-btn\.stop/, '仍残留 .stop（该按钮是暂停/恢复，不是停止）')
})

it('e2e 依赖的 .primary-btn.head-run 选择器仍能命中', () => {
  // [coupling] e2e/ai-runner.spec.ts 用 `.primary-btn.head-run` 找这个按钮；
  //   配色重构若把 head-run 改名，e2e 会静默失配（找不到元素 → 超时而非断言失败）。
  assert.match(read(E2E), /\.primary-btn\.head-run/, 'e2e 不再用该选择器，说明它已改名 —— 请同步更新本断言')
  const src = stripComments(read(TOOLBAR))
  const hits = src.match(/class="primary-btn[^"]*head-run"/g) || []
  assert.equal(hits.length, 2, `开始态与运行/暂停态都应带 head-run，实际 ${hits.length} 处`)
})

it('死样式 .primary-btn.stop（"停止=红"）不得复活 —— 它与新语义冲突', () => {
  const bad = /\.primary-btn\.stop\s*[,{]/.test(stripComments(read(FILE_TREE_SCSS)))
  assert.ok(!bad, 'file-tree.scss 里又出现了 .primary-btn.stop（停止=红 与 暂停=琥珀/恢复=绿 双源分叉）')
})

// ── ③ 对比度：读真令牌值算真比值 ──────────────────────────────────────────

/** 解析 `--name: value;` 声明。值必须以非空白开头，避免 `\s*` 与值捕获互相回退（super-linear backtracking）。 */
function vars(block: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^\s;][^;]*);/g)) out[m[1]] = m[2].trim()
  return out
}

function srgb(c: number): number {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  const h = hex.slice(1)
  const [r, g, b] = [0, 2, 4].map(i => Number.parseInt(h.slice(i, i + 2), 16))
  return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b)
}

/** WCAG 相对亮度对比度 */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** 取暗/亮两套主题的令牌表 */
function themes(): Array<[string, Record<string, string>]> {
  const css = read(STYLE_CSS)
  const lightAt = css.indexOf(LIGHT_THEME_SELECTOR)
  assert.ok(lightAt > 0, 'style.css 里找不到亮色主题块（[data-theme=light]）')
  const dark = vars(css.slice(0, lightAt))
  const light = { ...dark, ...vars(css.slice(lightAt)) }
  return [['暗色', dark], ['亮色', light]]
}

it('暂停/恢复两态的令牌在暗、亮两套主题下都可读（对比度达标）', () => {
  // 背景分两层，因为实测发现按钮**并不**直接压在 --bg 上：
  //   · 工具条实压在编辑器卡片 `.editor.card` 上 —— 探针沿祖先链解出亮色下 = --surface-2 (#eaeef2)；
  //   · --bg / --surface 是更朴素的背景层，作为「离开卡片也还能读」的加严档。
  // 门槛按元素性质取：
  //   · 本按钮是 icon-only 控件 ⇒ 适用 WCAG 1.4.11「非文本对比」= ≥ 3:1（对真实所在的卡片层）；
  //   · 另按 4.5:1（WCAG 1.4.3 文字档）要求 --bg / --surface 两层，留出余量。
  const NON_TEXT_MIN = 3.0
  const TEXT_LIKE_MIN = 4.5
  for (const [name, v] of themes()) {
    for (const tok of ['--warning', '--success']) {
      const val = v[tok]
      assert.match(val || '', /^#[0-9a-f]{6}$/i, `${name}的 ${tok} 不是纯 hex（=${val}），本判据无法计算对比度`)
      for (const bg of ['--bg', '--surface']) {
        const bgv = v[bg]
        assert.match(bgv || '', /^#[0-9a-f]{6}$/i, `${name}的 ${bg} 不是纯 hex（=${bgv}）`)
        const r = contrast(val, bgv)
        assert.ok(r >= TEXT_LIKE_MIN, `${name}主题 ${tok}(${val}) 压在 ${bg}(${bgv}) 上对比度仅 ${r.toFixed(2)}:1 < ${TEXT_LIKE_MIN}:1 —— 按钮会看不清`)
      }
      const card = v['--surface-2']
      assert.match(card || '', /^#[0-9a-f]{6}$/i, `${name}的 --surface-2 不是纯 hex（=${card}）`)
      const rc = contrast(val, card)
      assert.ok(rc >= NON_TEXT_MIN, `${name}主题 ${tok}(${val}) 压在编辑器卡片层 --surface-2(${card}) 上对比度仅 ${rc.toFixed(2)}:1 < ${NON_TEXT_MIN}:1 —— 这是按钮实际所在的背景`)
    }
  }
})

it('对比度判据自身有效：旧粉紫在新判据下必须被判不合格', () => {
  // 反向对照：若这条不成立，说明上面的阈值算错了 / 算的是别的颜色，整套对比度判据就是空的。
  const r = contrast('#f0abfc', '#ffffff')
  assert.ok(r < 4.5, `旧粉紫对白底竟算出 ${r.toFixed(2)}:1，对比度函数有问题`)
})
