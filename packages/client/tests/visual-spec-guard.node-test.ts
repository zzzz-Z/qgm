// [visual-spec-guard-v1] 视觉基线 spec 的双向守卫：spec 引用的选择器 ↔ 客户端源码。
// [WHY] 2026-10-05 复核实测：visual.spec.ts 的 6 个遮罩里 3 个（.hms / .term-body / .worklog-time）
//   在源码中已不存在，运行时命中 0 —— 遮罩静默失效、基线抖动风险回来，而 e2e 全红被当成「基线过期」，
//   长期无人区分。这类「选择器锈蚀」不会让任何单测变红，必须显式守卫。
// [CONSTRAINT] 扫描必须排除 e2e/ 与 tests/：spec 自己当然包含这些字符串，否则守卫恒真。
// CHANGE-IMPACT: 改 visual.spec.ts 的选择器而不改本清单 ⇒ 本文件变红（强制两边同步）。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const CLIENT = path.join(ROOT, 'packages', 'client')
const SPEC = path.join(CLIENT, 'e2e', 'visual.spec.ts')
const SNAP_DIR = path.join(CLIENT, 'e2e', 'visual.spec.ts-snapshots')
const SPEC_SRC = fs.readFileSync(SPEC, 'utf8')

/** 扫描客户端源码时必须跳过的目录（含 spec 自身所在目录，否则判据恒真） */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'e2e', 'tests', 'test-results', 'playwright-report', 'coverage', '.vite'])

/**
 * 读全部客户端源码文本（排除测试与产物）
 * [visual-spec-guard-v2] **必须剥掉 <style> 段与独立 .css 文件**。
 * WHY: 「元素还在不在」不能拿「整仓有没有这个字符串」来判 —— 元素删掉后 CSS 规则常常残留：
 *   `.term-body` 就是这样活下来的（元素早已不存在，只剩 style.css 里两条 `:focus` 规则），
 *   于是任何 token 级检查都会把它判成「存在」，正是 D2-d 那类静默失效得以长期潜伏的原因。
 * CHANGE-IMPACT: 改回不剥样式后，本文件对「模板元素改名、CSS 未改」这一类回归会变绿（判据失效）。
 */
function readClientSources(): string {
  const chunks: string[] = []
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p)
        continue
      }
      if (!/\.(?:vue|ts|html)$/.test(e.name)) continue
      if (/\.(?:spec|node-test)\.ts$/.test(e.name)) continue
      const txt = fs.readFileSync(p, 'utf8')
      chunks.push(p.endsWith('.vue') ? txt.replace(/<style[\s\S]*?<\/style>/g, '') : txt)
    }
  }
  walk(CLIENT)
  return chunks.join('\n')
}

const CLIENT_SRC = readClientSources()

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 类名 token 是否作为 class / CSS 选择器出现（要求左边界 + 右边界，避开子串误判） */
function hasClassToken(src: string, cls: string): boolean {
  return new RegExp(`(?:^|[\\s"'\`.{[(,:])${escapeRe(cls)}(?![\\w-])`, 'm').test(src)
}

/** 取 spec 里 `const <name> = [` 之后的字符串数组 */
function stringArray(code: string, name: string): string[] {
  const at = code.indexOf(`const ${name} = [`)
  assert.ok(at >= 0, `visual.spec.ts 缺少 const ${name} = [...]`)
  const end = code.indexOf(']', at)
  assert.ok(end > at, `const ${name} 数组未闭合`)
  return [...code.slice(at, end).matchAll(/'([^']*)'/g)].map(m => m[1])
}

/** spec 引用的类选择器 / 类名 token：与 visual.spec.ts 同构，改一处必须改两处 */
const SPEC_CLASS_TOKENS = [
  '.hdr',
  '.side-tab',
  '.side-tab-active',
  '.side-changes',
  '.side-worklog',
  '.side-collapse-btn',
  '.pane-side',
  '.cm-content',
  'is-collapsed',
]

/** spec 引用的 aria-label：与 SidePane.vue 的按钮一致 */
const SPEC_LABELS = ['文件树', '变更列表', '工作日志']

const MASK_SELECTORS = stringArray(SPEC_SRC, 'MASK_SELECTORS')

/**
 * [scroll-mask-ban-v1] 本仓真实滚动容器类名（.vue 模板里带 overflow-y:auto / overflow:auto 的块）。
 * [WHY] §15 明令禁止「加宽遮罩 / 遮掉整片滚动区」，但此前无机器判据：把 .wl-scroll 加回 mask
 *   或新增一条 '.diff-body' 遮罩，都不会让任何测试变红 —— 于是「视觉回归在某面板上真空」的
 *   缺陷可以再次潜伏（2026-10-07 实测：03 工作日志一度遮整片 .wl-scroll，滚动区内所有 UI 改动都不进判据）。
 * [CONSTRAINT] 清单须与源码双向同步：token 不在源码中 ⇒ 清单锈蚀变红；mask 里出现清单 token ⇒ 真空变红。
 * [CHANGE-IMPACT] 内容不确定的用例应改用 page.route() mock 固定数据（见 03 的 WORKLOG_FIXTURE_*），
 *   而不是加宽遮罩；增删滚动容器时改这里 + 跑本文件。
 */
const SCROLL_CONTAINER_TOKENS = [
  'wl-scroll', // WorklogPane 变更文件清单
  'diff-body', // DiffViewer 行级 diff 体
  'file-list', // FileList 变更列表体
  'awl-list', // AiWindowList 窗口列表
  'tp-list', // TaskProgressPanel 任务列表
  'script-card-tail', // ScriptCard 输出尾
  'attach-bar', // ScriptAttachBar / ScriptPanel 附件条
  'chat-list', // TerminalPane 聊天流
  'flow-timeline', // TerminalPane 时间线
]

test('每个遮罩选择器都真实存在于客户端源码（防选择器锈蚀）', () => {
  assert.ok(MASK_SELECTORS.length >= 3, `遮罩太少（${MASK_SELECTORS.length}）：<3 时基线必然抖动`)
  for (const sel of MASK_SELECTORS) {
    assert.ok(sel.startsWith('.'), `遮罩选择器应为类选择器，实际 ${sel}`)
    assert.ok(
      hasClassToken(CLIENT_SRC, sel.slice(1)),
      `遮罩 ${sel} 在客户端源码中不存在 ⇒ 遮罩静默失效（运行时命中 0），基线会抖动。`
      + `请改用真实存在的类，或从 MASK_SELECTORS 里删掉它。`,
    )
  }
})

test('遮罩清单不得为空转：至少有一个遮罩真的能在运行时命中', () => {
  // 反向保障：若 MASK_SELECTORS 全是拼错的类名，上一条会红；若有人把它整段删空，本条兜住
  assert.ok(MASK_SELECTORS.every(s => s.length > 1), `存在空选择器：${JSON.stringify(MASK_SELECTORS)}`)
})

// [worklog-fixture-v1] 03 工作日志的基线一度靠「遮掉整片 .wl-scroll」来消除 git 派生抖动，
// 但那使「文件列表 / 分组头 / diff 展开区」的任何 UI 改动都不进判据 —— 视觉回归在该面板上真空。
// 改为 route mock 固定数据：内容确定化 ⇒ 撤掉宽遮罩，滚动区真正进基线。
// [CONSTRAINT] mock 必须比 03 点击 worklog tab 更早注册（WorklogPane 挂载即 fetch）；
//   mock 后不得再引入对滚动区的整片遮罩。
// CHANGE-IMPACT: 把 03 改回「真实 git 端点 + 遮 .wl-scroll」⇒ 本文件变红。
test('03 工作日志必须用 route mock 固定数据，且不得整体遮罩滚动区', () => {
  const at = SPEC_SRC.indexOf('03 工作日志')
  assert.notEqual(at, -1, 'visual.spec.ts 找不到 03 工作日志 用例')
  const next = SPEC_SRC.indexOf('04 编辑器聚焦', at)
  const body = SPEC_SRC.slice(at, next === -1 ? SPEC_SRC.length : next)

  // 三个 git 端点必须全部被 route 拦截
  for (const endpoint of ['git/worklog', 'git/diff', 'git/head']) {
    assert.ok(
      body.includes(endpoint),
      `03 用例必须 route mock ${endpoint}：未 mock 则内容 = 当前 git 工作区状态，基线必抖；`
      + `或被改回整片遮罩（判据真空）。`,
    )
  }
  assert.ok(
    body.includes('page.route'),
    '03 用例必须用 page.route 固定数据 —— 否则只能靠遮罩消抖，滚动区进不了判据',
  )
  // 滚动区不得再进 mask
  assert.ok(
    !body.includes('\'.wl-scroll\''),
    '03 用例不得再遮 .wl-scroll —— 整片遮罩会让滚动区内所有 UI 改动对视觉回归不可见（判据真空）',
  )
  // 等固定数据行渲染出来，防截到 loading 骨架（骨架退场前截到也算「UI 无回归」的假绿）
  assert.ok(
    body.includes('wl-item-head'),
    '03 用例必须等 .wl-item-head 出现再截图 —— 否则可能截到 loading 骨架，UI 改动不触发差异',
  )
})

test('spec 引用的视图选择器与源码对齐（双向）', () => {
  for (const tok of SPEC_CLASS_TOKENS) {
    assert.ok(SPEC_SRC.includes(tok), `visual.spec.ts 已不再引用 ${tok}，请同步本守卫的清单（防守卫变陈旧）`)
    assert.ok(hasClassToken(CLIENT_SRC, tok.replace(/^\./, '')), `${tok} 在客户端源码中不存在 ⇒ spec 里的定位会超时或空转`)
  }
  for (const label of SPEC_LABELS) {
    assert.ok(SPEC_SRC.includes(label), `visual.spec.ts 已不再引用 aria-label ${label}，请同步本守卫`)
    assert.ok(new RegExp(`["']${escapeRe(label)}["']`).test(CLIENT_SRC), `aria-label "${label}" 在源码中不存在 ⇒ 侧栏 tab 定位会失败`)
  }
})

test('MASK_SELECTORS 不得含滚动容器类名（§15 禁止整片遮罩）', () => {
  const hit = MASK_SELECTORS.map(s => s.replace(/^\./, '')).filter(s => SCROLL_CONTAINER_TOKENS.includes(s))
  assert.equal(hit.length, 0, `MASK_SELECTORS 含滚动容器类名 ⇒ 整片遮罩使该区域所有 UI 改动对视觉回归不可见（判据真空）：${hit.join(', ')}`)
})

test('spec 内任何 mask 字面量都不得含滚动容器类名（防绕过 MASK_SELECTORS）', () => {
  const lines = SPEC_SRC.split(String.fromCharCode(10))
  const offenders: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue
    for (const t of SCROLL_CONTAINER_TOKENS) {
      const q = String.fromCharCode(39)
      const d = String.fromCharCode(34)
      if (line.includes(`${q}.${t}${q}`) || line.includes(`${d}.${t}${d}`)) {
        offenders.push(`L${i + 1}: .${t}`)
      }
    }
  }
  assert.equal(offenders.length, 0, `visual.spec.ts 的 mask 出现滚动容器类名 ⇒ 判据真空：${offenders.join(', ')}（改用 page.route() mock 固定数据）`)
})

test('滚动容器清单与源码双向对齐（防清单锈蚀）', () => {
  for (const t of SCROLL_CONTAINER_TOKENS) {
    assert.ok(hasClassToken(CLIENT_SRC, t), `滚动容器 ${t} 在源码中不存在 ⇒ 清单锈蚀；改类名 / overflow 时须同步本清单`)
  }
})

test('视觉基线：12 张、且逐张互不相同（防基线退化）', () => {
  assert.ok(fs.existsSync(SNAP_DIR), `基线目录不存在：${SNAP_DIR}（先跑 pnpm test:e2e --update-snapshots）`)
  const pngs = fs.readdirSync(SNAP_DIR).filter(n => n.endsWith('.png')).sort()
  assert.equal(pngs.length, 12, `基线数量应为 12（6 视图 × 2 主题），实际 ${pngs.length}：${pngs.join(', ')}`)
  const byHash = new Map<string, string[]>()
  for (const n of pngs) {
    const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(SNAP_DIR, n))).digest('hex').slice(0, 16)
    const list = byHash.get(h) ?? []
    list.push(n)
    byHash.set(h, list)
  }
  const dup = [...byHash.values()].filter(v => v.length > 1)
  const detail = dup.map(g => `  ${g.join(' ≡ ')}`).join('\n')
  assert.equal(
    dup.length,
    0,
    `基线退化：有 ${dup.length} 组逐像素相同的截图 ⇒ 说明主题没生效或两个「视图」其实是同一个状态。\n${detail}`,
  )
})
