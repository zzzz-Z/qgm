// @vitest-environment happy-dom
// [aiwin-collapse-default-v1] AI 站点面板「默认折叠」的承重判据（真组件 + 真折叠态 + 真 localStorage）。
// [WHY] 该需求的全部风险都藏在**一个 fallback 参数**里：useFoldState.isOpen 的默认 fallback 是 `true`，
//   漏传 / 传错就静默退化成「默认展开」，而界面看起来完全正常（CSS、按钮都在）——很难靠人眼回归发现。
// [trae-shell-v1] 折叠按钮常驻 AiWindowList 顶部（与品牌并排），折叠态改为模块级单例
//   useAiWindowListCollapse —— 支持未来跨组件（如 header）共享同一份状态；
//   本测试断言「按钮入口在 AiWindowList 内」，并覆盖折叠态 class 与样式可达性。
import { mount } from '@vue/test-utils'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { beforeAll, beforeEach, expect, test, vi } from 'vitest'

const ROOT = process.cwd()
const LIST_REL = 'packages/client/components/panels/AiWindowList.vue'
const COLLAPSE_REL = 'packages/client/composables/ui/useAiWindowListCollapse.ts'
const FOLD_KEY = 'airunner:fold:default:ai-window-list'

const g = globalThis as unknown as Record<string, unknown>

let AiWindowList: any

beforeAll(async () => {
  const vue = await import('vue')
  const vueuse = await import('@vueuse/core')
  for (const [k, v] of Object.entries({ ...vue, ...vueuse })) {
    if (!(k in g)) g[k] = v
  }
  const winTable = await import('../composables/ai/useAiWindowTable')
  const site = await import('../composables/ai/useAiSite')
  const aiWin = await import('../composables/ai/useAiWindow')
  const toastMod = await import('../composables/ui/useToast')
  Object.assign(g, winTable, site, toastMod)
  g.openSite = aiWin.openSite

  AiWindowList = (await import('../components/panels/AiWindowList.vue')).default as any
})

function mountList() {
  return mount(AiWindowList, { global: { directives: { tooltip: {} } } })
}

beforeEach(() => {
  localStorage.clear()
  // [multi-site-matrix-v1] 面板 onMounted 会 fetch /__ai/workspace/session 与 /workspace/registry；
  //   happy-dom 无服务端 → ECONNREFUSED 噪音淹没真实失败。stub 为空响应即可（断言不依赖数据）。
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })))
})

test('默认折叠：无任何存储时挂载即带 is-collapsed，且存储里不出现 expanded 键', () => {
  const w = mountList()
  assert.ok(w.classes().includes('is-collapsed'), '面板默认没折叠（fallback 传成了 true？）')
  const stored = JSON.parse(localStorage.getItem(FOLD_KEY) || '{}') as Record<string, unknown>
  assert.ok(stored.expanded === undefined, `挂载即把 expanded 写成 ${String(stored.expanded)} ⇒ 默认值被固化`)
})

test('[brand-toggle-v1] 折叠入口是顶部闪电图标，独立 ◧ 按钮已删且顶栏不得再 aria-hidden', () => {
  const listSrc = fs.readFileSync(path.join(ROOT, LIST_REL), 'utf8')
  // [WHY] 用户要求「删除展开收起按钮，把功能移到左侧闪电图标上」。
  //   回归形态：① ◧ 按钮回来（双入口）② 闪电只剩图标、点击无反应（功能丢失，界面上看不出来）
  //   ③ 顶栏恢复 aria-hidden —— 那会把唯一的开关从无障碍树里摘掉，键盘/读屏用户彻底没法折叠。
  assert.ok(!listSrc.includes('hdr-collapse-btn'), '独立折叠按钮应已删除（功能挪到闪电图标上）')
  assert.ok(listSrc.includes('aiWindowListCollapsed'), 'AiWindowList 未引用共享折叠态')
  assert.ok(!listSrc.includes('awl-collapse'), 'AiWindowList 内残留 awl-collapse ⇒ 折叠入口重复')
  // 闪电按钮必须真挂上切换：class + 同一元素内的 @click 翻转
  const btn = listSrc.match(/<button[\s\S]*?class="logo-btn"[\s\S]*?<\/button>/)
  assert.ok(btn, '缺少包住闪电图标的按钮（.logo-btn）')
  assert.match(btn![0], /@click="aiWindowListCollapsed = !aiWindowListCollapsed"/, '.logo-btn 未挂折叠切换')
  assert.match(btn![0], /:aria-expanded="!aiWindowListCollapsed"/, '.logo-btn 缺少 aria-expanded（折叠态对读屏不可见）')
  // 顶栏容器不许 aria-hidden：开关就在里面
  const spacer = listSrc.match(/<div class="awl-top-spacer"[^>]*>/)
  assert.ok(spacer, '缺少 .awl-top-spacer')
  assert.ok(!/aria-hidden/.test(spacer![0]), '顶栏 aria-hidden 会把折叠开关从无障碍树里摘掉')
  // 折叠态仍要显示闪电：顶栏本身不得按折叠态 v-if 掉（否则收起后无入口可点）
  assert.ok(!/v-if/.test(spacer![0]), '顶栏容器不得 v-if：收起后闪电会一起消失，用户无法再展开')
  assert.match(listSrc, /<h1 v-if="!aiWindowListCollapsed"/, 'QGM 文字应仍随折叠态隐藏（图标条只留闪电）')
})

test('共享单例字面量：fallback 必须显式为 false（默认折叠≠默认展开）', () => {
  const src = fs.readFileSync(path.join(ROOT, COLLAPSE_REL), 'utf8')
  assert.match(
    src,
    /fold\.isOpen\(\s*'expanded'\s*,\s*false\s*\)/,
    '默认折叠依赖显式 fallback=false；省略它 = useFoldState 默认 true = 静默变回默认展开',
  )
  expect(src.includes('useFoldState(\'default\', \'ai-window-list\')')).toBe(true)
})

test('跨组件共享单例：改 aiWindowListCollapsed 立即同步到组件（header 按钮与左栏同源）', async () => {
  // [trae-shell-v1] 按钮在 AiWindowList，状态由本单例承载；此用例覆盖「改状态 → 组件响应」这条链。
  // [CONSTRAINT] 不能靠 localStorage.setItem 后再 mount 验「重载尊重选择」——单例在模块加载时已冻结 storage 快照，
  //   且同 tab 内无 storage 事件；那属于浏览器行为，应在 e2e 层覆盖。
  const { aiWindowListCollapsed } = await import('../composables/ui/useAiWindowListCollapse')
  aiWindowListCollapsed.value = false
  const w = mountList()
  assert.ok(!w.classes().includes('is-collapsed'), '共享单例设 false 后组件未同步展开')
  aiWindowListCollapsed.value = true
  await w.vm.$nextTick()
  assert.ok(w.classes().includes('is-collapsed'), '改回 true 后组件未同步折叠')
})

test('折叠态样式承重：48px 图标条 + 隐藏文字块/删除钮/新建标签，且保留行首文件夹图标', () => {
  const src = fs.readFileSync(path.join(ROOT, LIST_REL), 'utf8')
  const style = src.slice(src.indexOf('<style'))
  const at = style.indexOf('.ai-window-list.is-collapsed')
  assert.ok(at > 0, '缺少 .ai-window-list.is-collapsed 样式块')
  const end = style.indexOf('\n\n', at)
  const collapsedRule = style.slice(at, end === -1 ? undefined : end)
  assert.match(collapsedRule, /flex:\s*0\s+0\s+48px/, '折叠态未收成 48px 图标条')
  for (const cls of ['.awl-meta', '.awl-close', '.awl-new-workspace-label']) {
    assert.ok(collapsedRule.includes(cls), `折叠态未隐藏 ${cls}`)
  }
  // [workspace-folder-lead-v1] 行首状态圆点已删，改由 14px 文件夹图标承担身份 + 激活色。
  //   三条判据：① 圆点彻底消失（不是 display:none 或只删模板留样式）
  //   ② 图标尺寸确实放大了（11px → 14px，用户说「稍微大一点」）
  //   ③ 图标必须排在 .awl-meta 之前 = li 的直接子元素：挂进 .awl-meta 会随它一起隐藏，行首变空
  //   [CONSTRAINT] 判据前剥注释：文件里的「原 .awl-dot 已删」说明会命中原类名，不剥就是假红。
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')
  assert.ok(!code.includes('awl-dot'), '旧状态圆点 .awl-dot 应已彻底删除（含样式与模板）')
  assert.match(code, /class="awl-folder" width="14" height="14"/, '文件夹图标应为 14px（原 11px，用户要求稍微大一点）')
  assert.ok(!/\.awl-item\.active[^{]*\.awl-dot/.test(code), '激活态不得再引用圆点')
  const folderAt = code.indexOf('class="awl-folder"')
  const metaAt = code.indexOf('class="awl-meta"', folderAt === -1 ? 0 : folderAt)
  assert.ok(folderAt > 0, '缺少 .awl-folder 图标')
  assert.ok(metaAt > folderAt, '文件夹图标必须排在 .awl-meta 之前（作为 li 的直接子元素），否则会随文字一起被隐藏')
  // [active-as-hover-v1] 选中态 = 悬停那一层灰，不要蓝色边和底（用户 2026-10-21 要求）。
  //   回归形态：① 蓝底回来（primary-bg）② 蓝色内描边回来 ③ 左缘蓝色竖条回来 ④ 选中色改成另一种灰却与悬停不一致。
  const activeBlocks = [...code.matchAll(/\.awl-item\.active[^{]*\{[^}]*\}/g)].map(m => m[0]).join('\n')
  assert.ok(activeBlocks.length > 0, '缺少 .awl-item.active 样式块')
  assert.ok(!/primary/.test(activeBlocks), '选中态仍引用主色（蓝底/蓝边/蓝字）——用户要求与悬停同灰')
  assert.ok(!code.includes('.awl-item.active::before'), '左缘蓝色激活竖条应已删除')
  assert.match(
    code,
    /\.awl-item:hover\s*\{[^}]*color-mix\(in srgb, var\(--text\) 8%, transparent\)/,
    '悬停底色不是那层 8% 灰 —— 选中态要与它一致，先钉住基准',
  )
  assert.match(
    code,
    /\.awl-item\.active\s*\{[^}]*color-mix\(in srgb, var\(--text\) 8%, transparent\)/,
    '选中态底色必须与悬停同灰（同一 color-mix 表达式），否则两者色差肉眼可见',
  )
})

test('[trae-modal-pick-v1] 新建工作区必须走模态弹窗 + 系统选择器，禁止手填路径', () => {
  const raw = fs.readFileSync(path.join(ROOT, LIST_REL), 'utf8')
  // [WHY] 用户明确要求「改为弹窗选择，所有都不要手填」；回归形态包括：
  //   ① 表单退回内联（无 Teleport 遮罩）② 路径字段退回 <input v-model=pathInput>
  //   ③ pick 按钮丢失 onPickTarget 挂点（点不动/无反应）
  //   [CONSTRAINT] 只断结构，不断样式细节——样式可回归，语义契约不可丢。
  assert.match(raw, /<Teleport to="body">/, '模态弹窗须用 Teleport 到 body（否则被面板 overflow 裁剪）')
  assert.match(raw, /class="awl-modal-mask"/, '缺少模态遮罩')
  assert.match(raw, /class="awl-modal-card"/, '缺少模态卡片容器')
  assert.ok(!/function openModal\(/.test(raw), 'openModal 死代码应已删除（模板直连 onNewWorkspaceDirect）')
  assert.match(raw, /function closeModal\(/, '缺少 closeModal 出口')
  assert.match(raw, /async function onPickTarget\(/, '缺少 onPickTarget（系统选择器入口）')
  assert.ok((raw.match(/@click="onPickTarget"/g) || []).length >= 1, '缺少 onPickTarget 挂点')
  const badPathInput = /<input[^>]*v-model="pathInput"/.test(raw)
  assert.ok(!badPathInput, '禁止手填工作区路径：必须改为按钮 + 只读展示（onPickTarget）')
  assert.ok(!raw.includes('class="awl-add-row"'), '旧内联 awl-add-row 残留')
  assert.ok(!raw.includes('@click="adding = true"'), '旧入口未改 openModal')
})

test('[trae-single-mode-v1] 只保留「目录」模式：分支/克隆 tab 及其模板与专属状态已删', () => {
  const raw = fs.readFileSync(path.join(ROOT, LIST_REL), 'utf8')
  // [WHY] 用户明示删掉「分支」「克隆」两个 tab；回归形态包括：
  //   ① tablist 回来了 ② worktree/clone 的模板分支还在 ③ 对应 ref/函数未清干净
  //   [CONSTRAINT] addMode 已彻底删除（openModal 删除后无读写点）；断言只看结构与语义，不锁样式。
  //   [CONSTRAINT] 判据前必须剥离注释：JSDoc 里会保留「原入口是 pathInput/urlInput 手填」「与 onPickRepo 共用 pickPath」等
  //     历史沿革说明，那些是有效文档而非死代码——不剥离会误判为残留。
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.ok(!raw.includes('role="tablist"'), '三模式 tablist 应已删除')
  assert.ok(!/addMode/.test(code), 'addMode 已无读写点，应彻底删除（不得只删比较分支）')
  assert.ok(!code.includes('branchInput'), 'branchInput 变量/引用残留')
  assert.ok(!code.includes('urlInput'), 'urlInput 变量/引用残留')
  assert.ok(!code.includes('baseRepoPath'), 'baseRepoPath 变量/引用残留')
  assert.ok(!code.includes('onPickRepo'), 'onPickRepo 函数/引用残留')
  // 三模式专属：listBranches / create 不应被本文件引用
  assert.ok(!code.includes('listBranches'), 'listBranches 引用残留')
  assert.ok(!code.includes('create('), 'create() 调用残留')
})

test('[workspace-open-newwin-v1] 每项含「在新窗口打开」按钮，且删除按钮不再受 active 限制', () => {
  const raw = fs.readFileSync(path.join(ROOT, LIST_REL), 'utf8')
  // 承重判据：① open-new 按钮存在且挂上 onOpenNewWindow ② onOpenNewWindow 真用 window.open
  //   ③ 删除按钮不再有 v-if="!w.active"（活跃项也可删）
  assert.match(raw, /class="awl-open-new"/, '缺少「在新窗口打开」按钮')
  assert.match(raw, /@click\.stop="onOpenNewWindow\(w\)"/, '新窗口按钮未挂 onOpenNewWindow')
  const fnIdx = raw.indexOf('function onOpenNewWindow')
  assert.ok(fnIdx > 0, '缺少 onOpenNewWindow 函数')
  const fnBody = raw.slice(fnIdx, fnIdx + 1200)
  // [open-new-session-v1] 语义：按钮 = 「在受控 AI 窗口里开新会话」（非新开浏览器窗口）。
  //   承重判据：必须调 activate(id, { newSession: true })——缺 newSession 会沿用旧会话 URL（用户实测进旧对话）。
  assert.match(fnBody, /activate\([^)]*newSession\s*:\s*true/, 'onOpenNewWindow 应以 newSession:true 激活该工作区')
  assert.ok(!/window\.open\(/.test(fnBody), 'onOpenNewWindow 不应新开浏览器窗口（那会同时打开新工作台页）')
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.ok(!/v-if="!w\.active"[^>]*class="awl-close"/.test(code), '删除按钮仍受 v-if="!w.active" 限制')
  assert.ok(!/<button[^>]*v-if="!w\.active"[^>]*>[\s\S]{0,200}?awl-close/.test(code), '删除按钮仍受 v-if="!w.active" 限制')
})

test('[awl-narrow-name-visible-v1] 窄屏（≤1100px）不得隐藏 .awl-meta，且不得再引用不存在的 .awl-item-name', () => {
  const raw = fs.readFileSync(path.join(ROOT, LIST_REL), 'utf8')
  const scss = raw.replace(/\/\*[\s\S]*?\*\//g, '')
  assert.ok(!scss.includes('.awl-item-name'), '.awl-item-name 在源码中不存在 ⇒ 该选择器恒不命中')
  // [WHY] 旧规则在 ≤1100px 一律 display:none 掉 .awl-meta，导致展开态名称消失（用户报告）。
  //   [CONSTRAINT] 断言「任何 max-width 媒体查询块内都不得出现 .awl-meta」——
  //   折叠隐藏由 .is-collapsed 承担，窄屏不得再按视口宽度藏名称。
  const mediaRe = /@media[^{]*max-width[^{]*\{/g
  let m: RegExpExecArray | null
  while ((m = mediaRe.exec(scss)) !== null) {
    // 从媒体查询块的 `{` 起做花括号配平，切出整块
    let depth = 1
    let i = m.index + m[0].length
    for (; i < scss.length && depth > 0; i++) {
      if (scss[i] === '{') depth++
      else if (scss[i] === '}') depth--
    }
    const block = scss.slice(m.index, i)
    assert.ok(!block.includes('.awl-meta'), `窄屏媒体查询块内隐藏了 .awl-meta ⇒ 展开态名称会消失：${block}`)
  }
})
