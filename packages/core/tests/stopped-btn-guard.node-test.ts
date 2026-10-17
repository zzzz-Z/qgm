// [stopped-btn-guard-v1] 守卫油猴 [stopped-btn-v1]（按钮状态驱动的 stopped 检测）探针层。
//
// 背景（2026-10-15 用户实测）：AI 讨论探针本身时，在正文里复述了「已停止回答」等关键词 ⇒
//   全文正则命中 ⇒ 误推 kind:'stopped' ⇒ 前端设 stoppedAtBySid ⇒ 10s 内到达的真实脚本被
//   stopped-window 闸门全部拦下（症状：脚本到达却不执行）。修法：stopped 判定从「正文关键词
//   计数」改为「停止按钮状态 + roots 冻结」（74d62526），本轮再补两件事：
//   ① [stop-btn-scope-v1] collectStopCandidates 只搜输入区——页面上任何瞬态可点击元素只要命中
//      STOP_LABEL_RE（上传 Cancel、对话框「取消生成」…），旧实现会让 isGenerating() 假 true，
//      其消失又伪造「按钮从有到无」+ roots 冻结 ⇒ 误推 stopped 杀整个循环（2026-10-16 复检
//      实测：空闲页一个 <button>Cancel</button> 即可走通整条链，探针 /tmp/stopped-btn-probe.cjs）；
//   ② 删净关键词死码（countStopMarkers / syncStopMarkerBaseline / stopMarkerBaseline /
//      stopMarkerText）——它们曾以 no-unused-vars 挂掉 pnpm lint（baseline lint=0 ⇒ dLint=2）。
//
// 本文件守两层：
//   A. 函数级行为（假 DOM 真跑，抠函数体 + vm 注入，同 multi-script-blocks 范式）：
//      collectStopCandidates / findStopGeneratingBtn / isGenerating 的范围收敛、DeepSeek
//      图签名兜底（[stop-btn-deepseek-icon-v1]）与其 fail-open 语义、rootsFrozenNow 冻结判据
//      （[stopped-btn-v2]，regenerate/回收不再误推）。
//   B. 源码结构 ratchet：classifyAndPost 的按钮状态追踪与 roots 冻结判据在位、关键词死码未回潮、
//      fill/rotate 两处轮次重置齐全、DeepSeek 图签名锚点未被篡改、stop-diag 带 dsIcon。
// [parity] headless 侧的同构探针与双通道常量一致性由 stopped-baseline-guard.node-test.ts 守。
//
// [KNOWN-GAP] classifyAndPost 是巨型闭包（~25 个自由变量：post / bodySignature /
//   extractLatestScript / countAssistantRoots / genRetryTimer …），仓库无既有 harness 先例，
//   「prevGenerating + rootsFrozen → post stopped」决策链本身**无行为覆盖**，只由 B 的结构断言
//   兜底；判据内部的纯函数（rootsFrozenNow / hasDeepSeekStopIcon）已有函数级覆盖。另有两个
//   已记录在案的运行态缺口（userscript 内 [KNOWN-LIMIT-1/2]）：
//   · roots 冻结依赖 assistant 根挂载时序：根随首 token 才挂载的站点，有部分输出的中断
//     roots 已增长 ⇒ 漏判（静默放行，循环不 finish、残余脚本照常回传）；
//   · DeepSeek 标签通道恒 miss，靠 [stop-btn-deepseek-icon-v1] 图签名锚点兜底；锚点是 bundle
//     坐标字面量，站点改版后 fail-open 静默退回 isGenerating() 恒 false（失效但不误报），
//     观测通道为 [stop-diag-v3] 的 dsIcon 字段 + B 的锚点 ratchet。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import vm from 'node:vm'

const ROOT = process.cwd()
const USERSCRIPT_REL = 'scripts/tampermonkey-session-id.user.js'

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

/** 抠出 `function <name>(...) { <inner> }` 的花括号内部（与 multi-script-blocks 同构） */
function extractInner(src: string, name: string): string {
  const re = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)[^{]*\\{`)
  const m = re.exec(src)
  assert.ok(m, `未找到函数 ${name}`)
  const braceAt = m.index + m[0].length - 1
  let depth = 0
  for (let i = braceAt; i < src.length; i++) {
    const c = src[i]
    if (c === '{') {
      depth += 1
    }
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return src.slice(braceAt + 1, i)
    }
  }
  throw new Error(`${name} 花括号不配平`)
}

interface FakeEl {
  tagName: string
  textContent: string
  disabled: boolean
  getAttribute: (n: string) => string | null
}
/** 带子查询能力的假节点（圆形按钮：hasDeepSeekStopIcon 要查内部 svg path） */
interface FakeBtnEl extends FakeEl {
  querySelectorAll: (sel: string) => FakeEl[]
}
interface FakeScope {
  querySelectorAll: (sel: string) => FakeEl[]
  querySelector: (sel: string) => FakeEl | null
  closest: (sel: string) => FakeScope | null
}
interface FakeDoc {
  querySelectorAll: (sel: string) => FakeEl[]
}
/** 输入框假节点：collectStopCandidates 用 parentElement，findStopGeneratingBtnStructural 用 closest */
interface FakeInputLike {
  parentElement: FakeScope
  closest: (sel: string) => FakeScope | null
}

const CLICKABLE_SEL = 'button, div[role], span[role], a[role], [role="switch"], [role="menuitem"]'

function makeEl(tag: string, attrs: Record<string, string | undefined>, text: string): FakeEl {
  return {
    tagName: tag.toUpperCase(),
    textContent: text,
    disabled: false,
    getAttribute: (n: string) => (n === 'class' ? attrs.class ?? null : attrs[n] ?? null),
  }
}

/**
 * 输入区容器假节点。[CONSTRAINT] closest 的行为决定 scope 解析走哪条分支：
 *   closestSelf=true  ⇒ pe.closest(selector-list) 命中（form / class*="input" 等）；
 *   closestSelf=false ⇒ 全不命中，退回 `|| pe` 兜底（真实站点里无 form 无 input 类名时走这条）。
 */
function makeComposer(children: FakeEl[], closestSelf: boolean): FakeScope {
  const c: FakeScope = {
    querySelectorAll: (sel: string) => (sel === CLICKABLE_SEL ? children : []),
    // findStopGeneratingBtnStructural 的 parentElement walk 会调 querySelector：现有用例的
    // children 均无 ds-button--circle 类 ⇒ 恒 null（walk 立即越过本层，对照 makeDsComposer）
    querySelector: () => null,
    closest: (_sel: string) => (closestSelf ? c : null),
  }
  return c
}

function makeDoc(all: FakeEl[]): FakeDoc {
  return {
    querySelectorAll: (sel: string) => (sel === CLICKABLE_SEL ? all : []),
  }
}

interface StopProbe {
  collectStopCandidates: () => FakeEl[]
  findStopGeneratingBtnStructural: () => FakeBtnEl | null
  hasDeepSeekStopIcon: (btn: FakeBtnEl) => boolean
  isGenerating: () => boolean
}

/**
 * 把油猴的探针函数抠出来真跑：标签通道（collectStopCandidates / findStopGeneratingBtn /
 * isGenerating）+ DeepSeek 兜底通道（findStopGeneratingBtnStructural / hasDeepSeekStopIcon）
 */
function buildStopProbe(doc: FakeDoc, input: FakeInputLike | null): StopProbe {
  const src = read(USERSCRIPT_REL)
  const reLine = src.match(/const STOP_LABEL_RE = (\/[\s\S]*?\/i)/)
  assert.ok(reLine, '未找到 STOP_LABEL_RE 声明（抠取依赖该字面量行）')
  const anchorsLine = src.match(/const DS_STOP_ICON_ANCHORS = (\[[^\]]*\])/)
  assert.ok(anchorsLine, '未找到 DS_STOP_ICON_ANCHORS 声明（抠取依赖该字面量行）')
  const innerCollect = extractInner(src, 'collectStopCandidates')
  const innerStructural = extractInner(src, 'findStopGeneratingBtnStructural')
  const innerIcon = extractInner(src, 'hasDeepSeekStopIcon')
  const innerFind = extractInner(src, 'findStopGeneratingBtn')
  const innerIsGen = extractInner(src, 'isGenerating')
  const body = `
var STOP_LABEL_RE = ${reLine[1]}
var DS_STOP_ICON_ANCHORS = ${anchorsLine[1]}
var document = deps.document
var findInputBox = deps.findInputBox
function collectStopCandidates() { ${innerCollect} }
function findStopGeneratingBtnStructural() { ${innerStructural} }
function hasDeepSeekStopIcon(btn) { ${innerIcon} }
function findStopGeneratingBtn() { ${innerFind} }
function isGenerating() { ${innerIsGen} }
return {
  collectStopCandidates: collectStopCandidates,
  findStopGeneratingBtnStructural: findStopGeneratingBtnStructural,
  hasDeepSeekStopIcon: hasDeepSeekStopIcon,
  isGenerating: isGenerating,
}
`
  const factory = vm.runInNewContext(`(function (deps) { ${body} })`, {}) as unknown as (deps: {
    document: FakeDoc
    findInputBox: () => FakeInputLike | null
  }) => StopProbe
  return factory({ document: doc, findInputBox: () => input })
}

/** 普通输入框假节点（closest 恒 null：标签通道用例不会意外滑入 DeepSeek 兜底） */
function makeInputBox(pe: FakeScope): FakeInputLike {
  return { parentElement: pe, closest: () => null }
}

test('isGenerating(): 输入区内的停止按钮可识别，输入区外的瞬态停止词按钮不误报', () => {
  const stopBtn = makeEl('button', { 'aria-label': 'Stop streaming' }, '')
  const cancelBtn = makeEl('button', {}, 'Cancel') // 页级瞬态元素（上传取消等）
  const composer = makeComposer([stopBtn], true)
  const probe = buildStopProbe(makeDoc([stopBtn, cancelBtn]), makeInputBox(composer))
  const cands = probe.collectStopCandidates()
  assert.equal(cands.length, 1, '输入区外命中 STOP_LABEL_RE 的 Cancel 不得进入候选（[stop-btn-scope-v1]）')
  assert.equal(cands[0], stopBtn)
  assert.equal(probe.isGenerating(), true)
})

test('isGenerating(): 输入区无停止按钮时，区外瞬态 Cancel 不再伪造生成态（FP 向量封堵）', () => {
  // 复检探针实测：旧实现（全域搜索）下这一个按钮就让 isGenerating()=true，其消失会走通
  // 「按钮从有到无 + roots 冻结」整条链 ⇒ 误推 stopped 杀循环。收敛后必须为 false。
  const cancelBtn = makeEl('button', {}, 'Cancel')
  const composer = makeComposer([], true)
  const probe = buildStopProbe(makeDoc([cancelBtn]), makeInputBox(composer))
  assert.equal(probe.collectStopCandidates().length, 0)
  assert.equal(probe.isGenerating(), false)
})

test('isGenerating(): 取不到输入框时退回 document 全域（无输入框页面行为不变）', () => {
  const stopBtn = makeEl('button', { 'aria-label': '停止生成' }, '')
  const probe = buildStopProbe(makeDoc([stopBtn]), null)
  assert.equal(probe.collectStopCandidates().length, 1)
  assert.equal(probe.isGenerating(), true)
})

test('collectStopCandidates: scope 解析在 closest 未命中时退回 parentElement 本身', () => {
  const stopBtn = makeEl('button', { 'aria-label': 'Stop streaming' }, '')
  const composer = makeComposer([stopBtn], false) // closest 恒 null ⇒ 走 `|| pe` 兜底
  const probe = buildStopProbe(makeDoc([stopBtn]), makeInputBox(composer))
  assert.equal(probe.collectStopCandidates().length, 1, '兜底分支必须仍能搜到输入区内的停止按钮')
})

// ── DeepSeek 图签名分支（[stop-btn-deepseek-icon-v1]）────────────────────────
// 背景：DeepSeek 发送/停止共用同一 DOM 元素且无 aria-label/title/text（[stop-btn-deepseek-fallback-v1]），
//   标签通道对它恒 miss ⇒ 修复前 isGenerating() 在该站点恒 false、stopped 探针不生效。
//   2026-10-16 从线上 bundle（chat.deepseek.com main.a0ce88b684.js，commit-id fd5d6ec3）逆向出
//   两态图标 path：停止态=圆角方块、发送态=上箭头。判据改为「圆形按钮内 svg path 命中停止方块
//   签名 ⇒ 生成中」，fail-open：签名失配视为非生成态（不误判，顶多漏判）。
// [fixture 来源] 下面两条 d 字面量逐字取自上述 bundle，与源码锚点同源；改任一处另一处必须同步。
const DS_STOP_D = 'M2 4.88C2 3.68009 2 3.08013 2.30557 2.65954C2.40426 2.52371 2.52371 2.40426 2.65954 2.30557C3.08013 2 3.68009 2 4.88 2H11.12C12.3199 2 12.9199 2 13.3405 2.30557C13.4763 2.40426 13.5957 2.52371 13.6944 2.65954C14 3.08013 14 3.68009 14 4.88V11.12C14 12.3199 14 12.9199 13.6944 13.3405C13.5957 13.4763 13.4763 13.5957 13.3405 13.6944C12.9199 14 12.3199 14 11.12 14H4.88C3.68009 14 3.08013 14 2.65954 13.6944C2.52371 13.5957 2.40426 13.4763 2.30557 13.3405C2 12.9199 2 12.3199 2 11.12V4.88Z'
const DS_SEND_D = 'M8.3125 0.980206C8.66767 1.05312 8.97902 1.2042 9.2627 1.43235C9.48724 1.613 9.73029 1.85795 9.97949 2.10716L14.707 6.8347L13.293 8.24876L9 3.95579V15.0417H7V3.95579L2.70703 8.24876L1.29297 6.8347L6.02051 2.10716C6.26971 1.85795 6.51277 1.613 6.7373 1.43235C6.97662 1.23988 7.28445 1.04404 7.6875 0.980206C7.8973 0.947029 8.1031 0.955183 8.3125 0.980206Z'

const CIRCLE_SEL = '[role="button"].ds-button--circle, button.ds-button--circle'
const SVG_PATH_SEL = 'svg path'

/** svg path 假节点（d 属性即图标签名的载体） */
function makeIconPath(d: string): FakeEl {
  return {
    tagName: 'path',
    textContent: '',
    disabled: false,
    getAttribute: (n: string) => (n === 'd' ? d : null),
  }
}

/**
 * DeepSeek 圆形主按钮假节点（发送态/停止态共用同一元素，仅内部 svg path 的 d 不同）。
 * [CONSTRAINT] class 必须含 ds-button--circle（findStopGeneratingBtnStructural 的判定依据），
 *   且不得含任何 STOP_LABEL_RE 可命中词——否则标签通道先命中，就测不到图签名分支了。
 */
function makeDsCircleBtn(iconD: string | null, disabled = false): FakeBtnEl {
  const paths = iconD === null ? [] : [makeIconPath(iconD)]
  return {
    tagName: 'DIV',
    textContent: '',
    disabled,
    getAttribute: (n: string) => {
      if (n === 'class') return 'ds-button ds-button--primary ds-button--filled ds-button--circle'
      if (n === 'role') return 'button'
      return null
    },
    querySelectorAll: (sel: string) => (sel === SVG_PATH_SEL ? paths : []),
  }
}

/**
 * DeepSeek 输入区容器假节点：
 * · closest 恒 null ⇒ collectStopCandidates 走 `|| pe` 兜底（scope=容器自身）；
 * · querySelectorAll(CLICKABLE_SEL) 返回圆钮（真实 DOM 里它是 div[role=button]，
 *   会被标签通道迭代但不命中 STOP_LABEL_RE ⇒ 仍须靠图签名兜底）；
 * · querySelectorAll/querySelector(CIRCLE_SEL) 返回圆钮 ⇒ structural 的
 *   parentElement walk 命中本层为 root。
 */
function makeDsComposer(circleBtns: FakeBtnEl[]): FakeScope {
  return {
    querySelectorAll: (sel: string) => {
      if (sel === CIRCLE_SEL) return circleBtns
      if (sel === CLICKABLE_SEL) return circleBtns
      return []
    },
    querySelector: (sel: string) => (sel === CIRCLE_SEL ? circleBtns[0] ?? null : null),
    closest: () => null,
  }
}

/** DS 输入框假节点：closest('form') 恒 null ⇒ 强制走 structural 的 parentElement walk 分支 */
function makeDsInputBox(pe: FakeScope): FakeInputLike {
  return { parentElement: pe, closest: () => null }
}

test('isGenerating(): DeepSeek 停止态（圆钮+停止方块图签名）判生成中', () => {
  const stopBtn = makeDsCircleBtn(DS_STOP_D)
  const probe = buildStopProbe(makeDoc([]), makeDsInputBox(makeDsComposer([stopBtn])))
  assert.equal(probe.collectStopCandidates().length, 0, 'DS 圆钮无标签 ⇒ 标签通道必须恒 miss（否则不需要图签名兜底）')
  assert.equal(probe.isGenerating(), true, '停止态图签名必须判生成中（修复前该站点恒 false，探针失效）')
})

test('isGenerating(): DeepSeek 发送态（同元素+上箭头图标）不得判生成中', () => {
  // 发送态与停止态共用同一 DOM 元素（[stop-btn-deepseek-fallback-v1]）：若兜底分支只看
  // 「圆形按钮存在」而忽略图标 ⇒ 恒真会把 generating gate 钉死、脚本全卡死。
  const sendBtn = makeDsCircleBtn(DS_SEND_D)
  const probe = buildStopProbe(makeDoc([]), makeDsInputBox(makeDsComposer([sendBtn])))
  assert.equal(probe.isGenerating(), false, '发送态不得判生成中（恒真会把 generating gate 钉死）')
})

test('isGenerating(): DeepSeek 未知图标按非生成态处理（fail-open，不误杀）', () => {
  // 站点改版换图标后锚点失配：必须静默失效（退回「该站点探针不生效」），不得误判生成中。
  const otherBtn = makeDsCircleBtn('M0 0h24v24H0z')
  const probe = buildStopProbe(makeDoc([]), makeDsInputBox(makeDsComposer([otherBtn])))
  assert.equal(probe.isGenerating(), false, '图签名失配必须 fail-open 为非生成态')
})

test('isGenerating(): DeepSeek 圆形按钮无 svg / disabled 时不得判生成中', () => {
  const noIcon = makeDsCircleBtn(null)
  const disabledStop = makeDsCircleBtn(DS_STOP_D, true)
  const probeA = buildStopProbe(makeDoc([]), makeDsInputBox(makeDsComposer([noIcon])))
  const probeB = buildStopProbe(makeDoc([]), makeDsInputBox(makeDsComposer([disabledStop])))
  assert.equal(probeA.isGenerating(), false, '无图标（签名不成立）不得判生成中')
  assert.equal(probeB.isGenerating(), false, 'disabled 按钮不得作为生成中信号')
})

test('findStopGeneratingBtnStructural(): 输入框在 form 内时直接以 form 为 scope', () => {
  const stopBtn = makeDsCircleBtn(DS_STOP_D)
  const form = makeDsComposer([stopBtn]) // 复用容器假节点：CIRCLE_SEL 查询返回圆钮
  const probe = buildStopProbe(makeDoc([]), {
    parentElement: makeDsComposer([]), // 占位 pe：collectStopCandidates 的 scope 兜底对象
    closest: (sel: string) => (sel === 'form' ? form : null),
  })
  assert.equal(probe.isGenerating(), true, 'form 分支必须能找到停止态圆钮')
})

test('hasDeepSeekStopIcon(): 逐 path 扫描，任一路径命中任一锚点即真', () => {
  const probe = buildStopProbe(makeDoc([]), null)
  // 手工注入多条 path（真实 svg 可能含多个 path）；第二条只含**第二个**锚点 ⇒ 同时钉住
  // .some() 的 OR 语义——退化成只查第一个锚点（DS_STOP_ICON_ANCHORS[0]）会被本用例抓住。
  const multi = makeDsCircleBtn(null)
  multi.querySelectorAll = (sel: string) => (sel === SVG_PATH_SEL
    ? [makeIconPath('M0 0h1v1H0z'), makeIconPath('M0 0V11.12C14 12.3199Z')]
    : [])
  assert.equal(probe.hasDeepSeekStopIcon(multi), true, '多 path 时任一锚点命中即应为真')
  assert.equal(probe.hasDeepSeekStopIcon(makeDsCircleBtn(DS_SEND_D)), false, '发送态图标不得命中')
})

test('rootsFrozenNow(): 计数与最后根身份均未变才判冻结（regenerate/虚拟列表回收不再误推）', () => {
  // [stopped-btn-v2] 冻结判据从「计数未增长」收紧为「计数 + 最后根身份均未变」。
  // 行为规格（误推方向只减不增）：
  const src = read(USERSCRIPT_REL)
  const inner = extractInner(src, 'rootsFrozenNow')
  const frozen = vm.runInNewContext(`(function (enterCount, enterRootId, nowCount, nowRootId) { ${inner} })`, {}) as unknown as (
    enterCount: number,
    enterRootId: string,
    nowCount: number,
    nowRootId: string,
  ) => boolean
  // 思考阶段被停（真停止）：计数与身份都停在进入 generating 时的旧回复上 ⇒ 冻结
  assert.equal(frozen(3, '10:旧回复甲', 3, '10:旧回复甲'), true, '思考期被停必须仍判冻结（真阳性不回归）')
  // regenerate 原地替换：旧根删、新根添 ⇒ 计数不变但身份变 ⇒ 不冻结（修复前误推 stopped）
  assert.equal(frozen(3, '10:旧回复甲', 3, '20:新回复乙'), false, 'regenerate 换根不得判冻结')
  // 虚拟列表回收旧根同时挂新根（DeepSeek 实测计数 3→1→2 抖动）：同样计数不变、身份变
  assert.equal(frozen(3, '10:旧回复甲', 3, '99:回收后新挂的根'), false, '回收+新挂不得判冻结')
  // 正常完成：新回复让计数增长 ⇒ 不冻结
  assert.equal(frozen(3, '10:旧回复甲', 4, '20:新回复乙'), false, '正常完成不得判冻结')
  // 首轮无根：enterCount=0 门槛 ⇒ 不冻结（无根站点的思考期停止不可判，[KNOWN-LIMIT-1]）
  assert.equal(frozen(0, '', 0, ''), false, '无根会话不予判定')
})

// ── 源码结构 ratchet ────────────────────────────────────────────────────────
// [WHY] 决策链（prevGenerating + rootsFrozen → post stopped）无行为覆盖（见文件头 KNOWN-GAP），
//   用结构断言防三种静默退化：判据被删、关键词探针复活、轮次重置漏改。
test('stopped 探针结构: 按钮状态追踪与 roots 冻结判据必须在位', () => {
  const src = read(USERSCRIPT_REL)
  assert.ok(src.includes('const currGen = isGenerating()'), 'classifyAndPost 必须追踪按钮状态（currGen）')
  assert.ok(src.includes('if (prevGenerating && !stopPosted)'), 'stopped 判据必须是「上一轮在生成 + 本轮未推过」')
  assert.ok(src.includes('genEnterRoots = countAssistantRoots()'), '进入 generating 必须记录 assistant 根数')
  assert.ok(src.includes('const rootsFrozen ='), 'roots 冻结判据必须在位')
  // [stopped-btn-v2] 冻结判据必须经 rootsFrozenNow 且带上根身份（否则 regenerate/回收误推复活）
  assert.ok(
    src.includes('rootsFrozenNow(genEnterRoots, genEnterRootId, rootsNow, assistantRootId())'),
    '冻结判据必须同时比较 roots 计数与最后根身份（[stopped-btn-v2]）',
  )
  assert.ok(
    src.includes('button, div[role], span[role], a[role], [role="switch"], [role="menuitem"]'),
    '可点击元素选择器被改动：假 DOM 与真实站点覆盖范围都会漂移',
  )
})

test('stopped 探针结构: DeepSeek 图签名锚点必须在位且被 isGenerating 消费', () => {
  const src = read(USERSCRIPT_REL)
  assert.ok(
    src.includes('const DS_STOP_ICON_ANCHORS = [\'M2 4.88C2 3.68009\', \'V11.12C14 12.3199\']'),
    '图签名锚点被改动：DeepSeek 分支静默失效（fail-open ⇒ 该站点 isGenerating() 恒 false）',
  )
  assert.ok(src.includes('function hasDeepSeekStopIcon'), '图签名判定函数必须在位')
  assert.ok(src.includes('hasDeepSeekStopIcon(dsBtn)'), 'isGenerating 必须消费图签名判定（否则兜底恒真/恒假）')
  assert.ok(src.includes('function findStopGeneratingBtnStructural'), 'DeepSeek 结构化兜底函数必须在位')
})

test('stopped 探针结构: fill/rotate 两处轮次重置齐全', () => {
  const src = read(USERSCRIPT_REL)
  // 重置行带 [stopped-btn-v1] tag；声明行（let prevGenerating = false / let genEnterRoots = 0）
  // 与 stopped 分支的消费行（prevGenerating = false）不带 tag，不会被计入。
  // 轮次重置已集中进 resetRoundState（fill / rotate 各调一次），故按「调用点计数 + 重置语句在位」判
  const resetCalls = (src.match(/resetRoundState\(\)/g) || []).length
  assert.ok(resetCalls >= 3, 'resetRoundState 必须在声明处 + fill + rotate 三处被调用（漏一处即漏配）')
  assert.ok(src.includes('prevGenerating = false'), 'prevGenerating 重置必须在 resetRoundState 内')
  assert.ok(src.includes('genEnterRoots = 0'), 'genEnterRoots 重置必须在 resetRoundState 内')
  // [stopped-btn-v2] 根身份与 genEnterRoots 同生共死：漏改会让上一轮的最后根身份跨轮次残留，
  //   新一轮「身份未变」恒真 ⇒ 冻结判据失真。
  // [CONSTRAINT] split 模式带「开新一轮」后缀：声明行（let genEnterRootId = ''）的注释
  //   不含该后缀，不会被计入（同 prevGenerating 例的处理）。
  assert.ok(src.includes('genEnterRootId = \'\''), 'genEnterRootId 重置必须在 resetRoundState 内')
  assert.ok(
    src.includes('genEnterRootId = assistantRootId()'),
    '进入 generating 必须同时记录最后根身份（只记计数会退回 [stopped-btn-v2] 修复前的误推）',
  )
})

test('stopped 探针结构: stop-diag 回传带 dsIcon（图签名锚点失效可观测）', () => {
  // [stop-diag-v3] 锚点失配是静默 fail-open；dsIcon 让「站点改版 ⇒ 兜底失效」在 stop 诊断里
  //   一看便知（hit=命中 / miss=圆钮在但两锚点均未命中 / na=无圆钮）。
  const src = read(USERSCRIPT_REL)
  assert.ok(
    src.includes('count: cands.length, brief, dsIcon, ver:'),
    'stop-diag 载荷必须带 dsIcon 字段',
  )
  assert.ok(
    src.includes('hasDeepSeekStopIcon(dsBtn) ? \'hit\' : \'miss\''),
    'dsIcon 必须由图签名探针实测产出（不能写死）',
  )
})

test('stopped 探针结构: 关键词死码不得回潮', () => {
  // 这些代码形态随 [stopped-btn-v1] 一起删除：AI 正文自指即误报（2026-10-15 实测），
  // 且死变量会以 no-unused-vars 挂掉 pnpm lint（2026-10-16 复检实测 2 errors）。
  // [CONSTRAINT] 只查**代码形态**（function/let/调用/赋值），不查裸符号名——userscript 里
  //   留了一段墓碑注释说明这些符号为何被删，按裸名断言会把墓碑本身判红。
  const src = read(USERSCRIPT_REL)
  const CODE_FORMS = [
    'function countStopMarkers',
    'function syncStopMarkerBaseline',
    'syncStopMarkerBaseline()',
    'let stopMarkerBaseline',
    'stopMarkerBaseline =',
    'let stopMarkerText',
    'stopMarkerText =',
  ]
  for (const form of CODE_FORMS) {
    assert.ok(!src.includes(form), `关键词 stopped 探针代码形态 ${form} 不得回潮`)
  }
})
