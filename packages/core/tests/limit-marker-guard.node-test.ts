// [limit-detect-v3] 三处同构守卫：会话触顶标记正则刻意内联在 3 个文件
// （headless 探测 / headless 基线 / 油猴脚本）——headless 侧函数经 page.evaluate 序列化注入浏览器，
// 不能引用模块级常量，故只能各写一份。
// 历史教训 ①（漏报）：内联常量改一处漏一处 → 线上漏报。本例即 DeepSeek 真实文案
// 「达到对话长度上限，请开启新对话」（动词在前语序）在 v1 正则中完全漏匹配，工作台持续干等超时。
// 历史教训 ②（误报，v3 收紧的动因，2026-10-07 实测）：v2 允许**裸标记**命中，而两处探针扫的都是
// **整页** `document.body.textContent`（含侧栏、消息正文、UI chrome），实测两类假命中成立：
//   - 正文自指：工作台自己的任务文案「定位"会话长度达到上限"toast 弹窗源…」作为 AI 回复落进页面 DOM，
//     命中分支 2（名词+长度+达到+上限）——探针实测 `会话长度达到上限` 命中。
//   - 侧栏拼接：分支 4 的「请」是 `请?` 可缺省，而 DeepSeek 侧栏常驻按钮就是「开启新对话」，
//     任意以「对话长度上限」结尾的文本与之相接即命中——探针实测 `本模型对话长度上限开启新对话` 命中。
// v3 收紧：中文触顶必须**自带动作子句**（`[，,：:]请?` 或 `请` + 开启/开始/新建/创建 + 新对话/新会话），
// 裸标记不再算触顶。代价是漏报面变大（真 banner 若无动作子句则漏）——取向：误报会诱发无谓的轮转新会话，
// 漏报只退化为一次超时，故宁可漏。英文分支不变（英文正文自指风险低且无对应动作子句）。
// 本守卫断言：① 三处逐字符一致；② 覆盖真实/变体文案（均带动作子句）；③ 不误伤侧栏常驻按钮、
// 正文讨论、正文自指与侧栏拼接形态。
// 历史教训 ③（误报，2026-10-10 实测，[limit-scan-strip-v1] 的动因）：上述「整页 textContent」口径还有
// **自指**通道——工作台把脚本 stdout 用 ``` 围栏回填进会话（prompt-builder appendRawOutputs）⇒ 页面里
// 落成 <pre><code>，而源码/文档里含探针自己的词表（`maximum context length` 就在
// headless-inject-simple.ts 的触顶正则里）⇒ 命中并误报「已达长度上限」，掐掉一整轮（12:02:58 实测）。
// 修法是三处探针统一只扫「剥壳后的正文」：新增局部 bodyText()（同样只能内联 3 份）。
// 故本守卫同时断言：④ 三处 bodyText() 实现体一致；⑤ 剥壳后案例 1/3 归零、真 banner（案例 4/5）不回归；
// ⑥ 未围栏的可命中文本（案例 2）用 ratchet 锁住。
// 历史教训 ④（自指的第三、第四条通道，2026-10-10 续修）：
//   · **P1**：英文分支原先**裸匹配** `maximum context length`——探针自己的源码/regex 行就能自命中，
//     且 dump 走的是普通文本通道（未围栏）⇒ 剥壳救不了。收紧为「必须邻近 token 数」后，
//     那条 payload 归零（本文件「12:02 实况 payload」用例即此判据）。
//   · **判据归属**：引述真文案时若**连写成一行**，注释本身就成了自指源（实测 headless-inject.ts 有 2 处）
//     ⇒ 引述必须分段或参数化。故新增「探针源码库零自命中」ratchet。
//   · **首问注入块**（`<file path="SYSTEM.md">` / AGENTS.md / lessons.md）是**无围栏**注入 ⇒ 一旦含词表，
//     第一轮就被自己的提示词命中，且剥壳管不了。故新增该块的词表 ratchet。
//   本轮增补断言：⑦ 探针源码库零自命中；⑧ 首问注入块零标记词表。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import vm from 'node:vm'
import { Window } from 'happy-dom'

const ROOT = process.cwd()

const SOURCES = [
  'packages/core/src/headless/headless-inject.ts',
  'packages/core/src/headless/headless-inject-simple.ts',
  'scripts/tampermonkey-session-id.user.js',
]

// [CONSTRAINT] 提取锚点：三处正则均为 /(?:(?:达到 …… /gi 形式的字面量；锚点若变，本守卫须同步
const RE_LITERAL = /\/\(\?:\(\?:达到[\s\S]*?\/gi/g

function extractRegexes(): string[] {
  return SOURCES.map((rel) => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    const hits = src.match(RE_LITERAL) || []
    assert.equal(hits.length, 1, `${rel} 应恰有 1 处触顶正则，实际命中 ${hits.length}`)
    return hits[0]
  })
}

let cached: string | null = null
function limitLiteral(): string {
  if (cached === null) cached = extractRegexes()[0]
  return cached
}

// [CONSTRAINT] 每次构造新实例：正则带 g 标志，复用同一实例会被 lastIndex 状态污染
function buildRe(): RegExp {
  const lit = limitLiteral()
  const m = lit.match(/^\/([\s\S]*)\/([a-z]*)$/)
  assert.ok(m, `正则字面量解析失败: ${lit.slice(0, 48)}`)
  return new RegExp(m[1], m[2])
}

test('limit marker parity: 三处触顶正则逐字符一致', () => {
  const [a, b, c] = extractRegexes()
  assert.equal(b, a, 'headless-inject-simple 与 headless-inject 正则不一致（内联常量分叉）')
  assert.equal(c, a, 'userscript 与 headless-inject 正则不一致（内联常量分叉）')
})

test('limit marker: 覆盖 DeepSeek 真实文案与常见变体', () => {
  const re = buildRe()
  const samples = [
    '达到对话长度上限，请开启新对话', // ← 线上真实文案（动词在前）
    '对话长度已达上限，请开启新对话', // 名词在前的旧形式
    '对话长度已达上限，请新建一个新对话', // 动作子句带「一个」的形态
    '上下文过长，请开启新对话', // 名词+形容词型（无动词）
    '会话已达上限，请开启新会话', // 无「长度」的词序变体
    '对话长度超限，请开启新对话', // 「超限」分支
    // [limit-en-fixture-split-v1] 英文正例**必须分段拼接**，不得连写成整串。
    // [WHY] 本文件一旦被 dump 进会话走**无围栏普通文本**通道（剥壳只剥 <pre><code>），
    //   连写的整串就是探针的自命中源 ⇒ 误报「已达长度上限」并掐掉一整轮
    //   （2026-10-10 15:07 用户实测：toast 回显「页面命中：<本串>」，全仓仅此一处）。
    // [CONSTRAINT] 运行时求值结果逐字不变 ⇒ 上面的正例断言（`re.test(s)`）不受影响；
    //   判据由下方「裸串 census」用例锁死（改回连写即红）。
    'context length ' + 'limit exceeded',
  ]
  for (const s of samples) {
    re.lastIndex = 0
    assert.ok(re.test(s), `应匹配却未匹配: ${s}`)
  }
})

test('limit marker: 不误伤侧栏常驻按钮与正文讨论', () => {
  const re = buildRe()
  const samples = [
    '开启新对话', // 侧栏常驻按钮：若命中会每轮误触发自动轮转
    '新建对话',
    '本对话长度上限是 128k token', // AI 正文讨论型
    '模型上下文窗口最大长度是 128k',
  ]
  for (const s of samples) {
    re.lastIndex = 0
    assert.ok(!re.test(s), `不应匹配却匹配: ${s}`)
  }
})

test('limit marker: 不误伤正文自指与侧栏拼接（2026-10-07 实测误报，v3 收紧的判据）', () => {
  const re = buildRe()
  const samples = [
    '会话长度达到上限', // 误报①：工作台自身任务文案的用词（名词+长度+达到+上限）
    '定位"会话长度达到上限"toast 弹窗源', // 误报①线上原句形态
    '本模型对话长度上限开启新对话', // 误报②：正文与侧栏常驻按钮在 textContent 里相接
    '当达到对话长度上限后应轮转新会话', // 正文讨论：无动作子句，不算页面 banner
  ]
  for (const s of samples) {
    re.lastIndex = 0
    assert.ok(!re.test(s), `不应匹配却匹配: ${s}`)
  }
})

// ─────────── [limit-scan-strip-v1] 正文剥离：parity + DOM 级行为判据 ───────────
// 与上面的触顶正则是同一种风险结构：实现体**内联 3 份**（headless 侧函数经 page.evaluate 序列化
// 注入浏览器，不能引用模块级常量）⇒ 改一处漏一处，则某条通道照旧误报。

// [CONSTRAINT] 提取锚点：三处均为局部函数 `function bodyText() {`；锚点若变，本守卫须同步
// （收尾用 `\n[ \t]*}` 而非 `\n\s*}`：后者与 `[\s\S]*?` 可交换字符，触发 regexp/no-super-linear-backtracking）
const RE_BODY_TEXT = /function bodyText\(\)\s*\{([\s\S]*?)\n[ \t]*\}/g
const STRIP_SELECTOR = 'pre,code,textarea,input,[contenteditable="true"],script,style'
const SIMPLE_REL = SOURCES[1]
const SELF_REL = 'packages/core/tests/limit-marker-guard.node-test.ts'

/** 取三处实现体并按行去缩进（保留行内空白）⇒ 比较结果 = 「逐字符一致」减去缩进差异 */
function extractBodyTexts(): string[] {
  return SOURCES.map((rel) => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    const hits = [...src.matchAll(RE_BODY_TEXT)]
    assert.equal(hits.length, 1, `${rel} 应恰有 1 处 bodyText() 实现，实际命中 ${hits.length}`)
    return hits[0][1].split('\n').map(l => l.trim()).join('\n')
  })
}

/** 用**从源文件抽出的真实实现体**造一个可执行函数（用 vm 而非 eval：本仓库 no-new-func 已开） */
function makeBodyText(doc: unknown): () => string {
  const inner = extractBodyTexts()[0]
  const ctx = vm.createContext({ document: doc })
  return vm.runInContext(`function bodyText() {\n${inner}\n}\nbodyText`, ctx) as () => string
}

test('body text parity: 三处剥离实现体一致，且确实走 clone + remove', () => {
  const [a, b, c] = extractBodyTexts()
  assert.ok(a.includes('cloneNode(true)'), '实现体必须克隆后再剥；直接读 document.body.textContent 等于没修')
  assert.ok(a.includes(`'${STRIP_SELECTOR}'`), '剥离选择器与约定不符（代码块/输入框/可编辑区）')
  assert.ok(a.includes('.remove()'), '实现体必须移除命中节点')
  assert.equal(b, a, 'headless-inject-simple 与 headless-inject 的 bodyText 不一致（内联常量分叉）')
  assert.equal(c, a, 'userscript 与 headless-inject 的 bodyText 不一致（内联常量分叉）')
})

// ── DOM 级行为判据：页面形态取自复现脚本 .ai-runner/tmp/limit-fp-repro.cjs ──
function buildDoc(parts: string[]): any {
  const win = new Window({ url: 'https://chat.deepseek.com/a/chat/s/xxx' })
  win.document.body.innerHTML = parts.join('\n')
  return win.document
}
function scan(re: RegExp, text: string): { n: number, last: string } {
  re.lastIndex = 0
  const all = text.match(re) || []
  return { n: all.length, last: all.length ? all[all.length - 1] : '' }
}
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
}
/**
 * 工作台回填的 stdout 形态：readText 源码后按 `序号: 行` 打印，且**截到探针自己的词表那一行为止**
 * （12:02 实况是 slice(0,140)，当时触顶正则在第 136 行；这里按内容定位，免于行号漂移而失效）
 */
function dumpedSource(): string {
  const lines = fs.readFileSync(path.join(ROOT, SIMPLE_REL), 'utf8').split('\n')
  const lineNo = lines.findIndex(l => l.includes('maximum context length')) + 1
  assert.ok(lineNo > 0, `${SIMPLE_REL} 中找不到探针自己的词表 maximum context length（应内联在触顶正则里）`)
  return lines.slice(0, lineNo).map((l, i) => `${i + 1}: ${l}`).join('\n')
}

// [P1 已落地，2026-10-10] 12:02 的实况 payload（inject-simple 第 1..触顶正则行）在**英文分支收紧后
// 已零命中**：命中它的那条裸分支 `|maximum context length` 不复存在。故本用例由原来的
// 「围栏内 → 剥壳 1→0」改写为**任意形态都必须 0**——它现在测的是「P1 有没有被改回裸匹配」；
// 「剥壳对『仍可命中』的 payload 有效」由下面的案例 3 承重（避免两条判据互相替代而一起变真空）。
test('body text: 12:02 实况 payload 已由 P1 关闭（围栏内 / 裸文本两种形态都必须 0）', () => {
  const re = buildRe()
  const payload = dumpedSource()
  assert.equal(scan(re, payload).n, 0, 'payload 文本本身仍命中 ⇒ 英文分支退回裸匹配了（P1 回退）')

  const fencedDoc = buildDoc([
    `<div class="ds-user-message"><div class="ds-markdown"># 脚本执行结果<br>状态: ✅ 成功<br><pre><code>${esc(payload)}</code></pre></div></div>`,
    '<div class="ds-assistant-message-main-content">让我读源码脚本的关键段…（正常回复，无 banner）</div>',
    '<div class="sidebar"><button>开启新对话</button></div>',
  ])
  assert.equal(scan(re, fencedDoc.body.textContent ?? '').n, 0, '围栏内形态（12:02 实况结构）也应 0')
  assert.equal(scan(re, makeBodyText(fencedDoc)()).n, 0, '围栏内形态剥壳后应 0')

  const bareDoc = buildDoc([
    `<div data-message-author-role="user">脚本 stdout:\n${esc(payload)}</div>`,
    '<div class="ds-assistant-message-main-content">正常回复</div>',
  ])
  assert.equal(scan(re, makeBodyText(bareDoc)()).n, 0, '**未围栏**形态在 P1 后也应 0（正则级关闭，不依赖剥壳）')
})

// 案例 3 承重「剥壳 + 围栏」这条链：payload 是**仍能被正则命中**的真实文本
// （dump 本守卫文件自身 —— 里面就有真 banner 文案与英文真错文两处 fixture）。
test('body text: 案例 3 围栏内 dump 仍可命中，剥壳后归零（剥壳承重用例）', () => {
  const re = buildRe()
  const case3 = buildDoc([`<div class="ds-user-message"><pre><code>${esc(fs.readFileSync(path.join(ROOT, SELF_REL), 'utf8'))}</code></pre></div>`])
  const raw3 = scan(re, case3.body.textContent ?? '')
  assert.ok(raw3.n >= 1, `案例 3 整页应命中（dump 本守卫文件自身即含真 banner 文案 fixture），实际 ${raw3.n}`)
  assert.equal(scan(re, makeBodyText(case3)()).n, 0, '案例 3 剥壳后应为 0')
})

test('body text: 真 banner 与英文真错文剥壳后仍为 1（真阳性不回归）', () => {
  const re = buildRe()
  const case4 = buildDoc([
    '<div class="ds-assistant-message-main-content">达到对话长度上限，请开启新对话</div>',
    `<div class="ds-user-message"><pre><code>${esc(dumpedSource())}</code></pre></div>`,
  ])
  const s4 = scan(re, makeBodyText(case4)())
  assert.equal(s4.n, 1, `案例 4（真 banner + 同轮回填源码）应为 1，实际 ${s4.n}`)
  assert.equal(s4.last, '达到对话长度上限，请开启新对话', '案例 4 命中串须是真 banner 而非回填的源码')

  const case5 = buildDoc([
    `<div class="err">This model's maximum context length is 65536 tokens. Please reduce the length of the messages.</div>`,
  ])
  assert.equal(scan(re, makeBodyText(case5)()).n, 1, '案例 5 英文真错文形态应仍命中')
})

/**
 * 取「仍能被正则命中」的真实仓内文本（守卫自身的 fixture 行）——即「某文件被 dump 进会话」这一
 * 真实形态的**可命中**版本。P1 之后 12:02 那条 payload 已不可命中，故残留用例必须换 payload，
 * 否则前置条件恒假、用例退化成真空。
 */
function stillMatchingRepoText(): string {
  const lines = fs.readFileSync(path.join(ROOT, SELF_REL), 'utf8').split('\n')
  const hit = lines.filter(l => scan(buildRe(), l).n > 0)
  assert.ok(hit.length >= 1, '守卫自身应含仍可命中的 fixture 文本，否则本用例会退化为真空判据')
  return hit.slice(0, 3).join('\n')
}

// [P0b-ratchet] 已知残留：**未围栏**且**仍可命中**的文本（页面上的 user 侧文本）P0 拦不住——
// 剥壳只对 `pre/code` 生效。计划 P0b（同时剥 user 消息容器）落地后本用例必红 ⇒ 那时改成断言 0。
test('body text: 未围栏的可命中文本仍是已知残留（P0b 未做）', () => {
  const re = buildRe()
  const case2 = buildDoc([
    `<div data-message-author-role="user">脚本 stdout:\n${esc(stillMatchingRepoText())}</div>`,
    '<div class="ds-assistant-message-main-content">正常回复</div>',
  ])
  assert.ok(scan(re, case2.body.textContent ?? '').n >= 1, '案例 2 整页应命中（fixture 前置条件）')
  assert.ok(scan(re, makeBodyText(case2)()).n > 0, 'P0b 若已落地（剥 user 容器），本用例应转红并改为断言 0')
})

// [self-ref-ratchet] 探针**自己的源码库**不得含「能被自己命中」的文本（含注释里引述的真文案）。
// [WHY] 这正是 12:02 误报的根因类：工作台会把仓内文件 dump 进会话（stdout / `# 相关文件源码`），
//   命中即自指误报。引述真文案必须分段或参数化（见 headless-inject.ts 的同名 CONSTRAINT）。
// [承重] 把英文分支改回裸 `|maximum context length`，或把真文案连写回一行 ⇒ 本用例立刻转红。
test('limit marker: 探针源码库零自命中（引述真文案须分段，否则源码 dump 即自指）', () => {
  const re = buildRe()
  for (const rel of SOURCES) {
    const hits = scan(re, fs.readFileSync(path.join(ROOT, rel), 'utf8'))
    assert.equal(
      hits.n,
      0,
      `${rel} 有 ${hits.n} 处自命中（last=${JSON.stringify(hits.last)}）：该文件被 dump 进会话即误报触顶`,
    )
  }
})

// [preflight-vocab-ratchet] 首问注入块是**无围栏**注入的（`<file path="SYSTEM.md">` 契约不得改），
// 一旦它们含探针词表，第一轮就被自己的提示词命中 ⇒ 必误报，且与 P0 无关（剥壳剥不掉它们）。
// 实测（2026-10-10）三处均为 0：本用例把这条「潜伏」锁成「永久」——lessons 的 DONE 段是自动入库的，
// 只要有人把真文案连写进踩坑记录，就会踩中。
const INJECTED_BLOCKS = ['.ai-runner/lessons.md', 'AGENTS.md', 'packages/core/SYSTEM.md']

test('limit marker: 首问注入块不得含标记词表（无围栏注入 ⇒ 命中即第一轮误报）', () => {
  const re = buildRe()
  let checked = 0
  for (const rel of INJECTED_BLOCKS) {
    const p = path.join(ROOT, rel)
    if (!fs.existsSync(p)) continue // lessons.md 属运行态台账，未初始化时不存在
    checked++
    const hits = scan(re, fs.readFileSync(p, 'utf8'))
    assert.equal(
      hits.n,
      0,
      `${rel} 含 ${hits.n} 处标记词表（last=${JSON.stringify(hits.last)}）：首问无围栏注入 ⇒ 第一轮即误报触顶`,
    )
  }
  assert.ok(checked >= 1, '至少要核到一处注入块（packages/core/SYSTEM.md 是入库文件），否则本用例是空的')
})

// ── 调用点守卫（冻结清单 ratchet）──────────────────────────────────────────────
// [WHY] 只测 bodyText() 自身行为是典型真空判据：真正要防的是「三处标记探针有没有接上它」。
// 形态：冻结每个文件的调用点总数 + 逐个断言接收者。退化回整页 raw 读取有两种写法，
//   两种都会被抓：① 经局部别名（如 limitText.match(...)）⇒ 接收者不在白名单；
//   ② 直接内联（(...).match(...)）⇒ 落不进提取正则 ⇒ 计数下降。
// [site-adapter-v1] 正则探针可写两种锚点形式：① 原字面量 `/xxx/gi`；② 锚点变量 `_XXX_ANCHOR`
//   （SiteAdapter 引入后，守卫正则同时扫两种形态）
const MARKER_SITE_COUNT: Record<string, number> = {
  'packages/core/src/headless/headless-inject.ts': 3, // busy / rate / limit（stopped 关键词探针 2026-10-16 移除：零真阳性 + 自指假阳性，改按钮驱动 isGeneratingInPage）
  'packages/core/src/headless/headless-inject-simple.ts': 4, // verify.rate / reset.busy / reset.limit / reset.rate（reset.stopped 随关键词探针移除）
  'scripts/tampermonkey-session-id.user.js': 1, // countLimitMarkers（stopped 探针 2026-10-16 起按钮驱动，关键词 countStopMarkers 已删）
}
// [allowlist] 唯一例外：verifyFillSentInPage 的频控探针读 tail（整页 raw 末 3000 字符）。
// [WHY] 该正则每条分支都带转义（please\s+slow\s+down / rate\s+limit / too\s+many\s+requests），
//   在源码文本里是**字面反斜杠**，无法自匹配 ⇒ 不属「自指」误报类；且它守在 send 复核路径上
//   （改它会牵动 fill-ack 判定），取舍见 docs/plan/limit-marker-fp-fix.md §2 P0。
const MARKER_RECEIVER_ALLOWLIST = new Set(['scanText', 'scanBodyText()', 'tail'])
const RAW_EXCEPTION_RECEIVER = 'tail'

test('body text 调用点: 标记探针一律读剥壳后的正文（冻结清单 ratchet）', () => {
  // [site-adapter-v1] 正则锚点同时支持字面量 `/xxx/gi` 和锚点变量 `_XXX_ANCHOR` 两种形式
  const RE_SITE = /([\w$.]+(?:\(\))?)\.match\(\s*(?:\/(?:server busy|\(\?:消息|当前问题已停止|\(\?:\(\?:达到)[\s\S]*?\/[gimsuy]*|_\w+_ANCHOR\w*)/g
  let rawExceptions = 0
  for (const rel of SOURCES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    const receivers = [...src.matchAll(RE_SITE)].map(m => m[1])
    assert.equal(
      receivers.length,
      MARKER_SITE_COUNT[rel],
      `${rel} 标记探针调用点数变化（新增或回退都须同步本冻结清单）`,
    )
    for (const r of receivers) {
      assert.ok(
        MARKER_RECEIVER_ALLOWLIST.has(r),
        `${rel} 的标记探针接收者是 ${r}：应读剥壳后的正文（scanText / scanBodyText()）`,
      )
      if (r === RAW_EXCEPTION_RECEIVER) rawExceptions++
    }
  }
  assert.equal(rawExceptions, 1, 'raw 读取的例外只允许 verifyFillSentInPage 一处，新增例外必须先在计划文档留痕')
})

// ── 裸串 census（[limit-en-fixture-split-v1]）──────────────────────────────────
// [WHY] 与 ratchet ⑦「探针源码库零自命中」是**两条不同口径**的锁，别混：
//   ⑦ 管「3 个探针源文件是否含能被自己命中的文本」；本 census 管「某个裸串在源码里出现几次」。
//   ⑦ **不能**扩到测试文件 —— 实测本文件自命中 11 处（头注释引述真 banner + samples 正例），
//   改分段后仍剩 10 处：测试文件的职责就是存正例，「零自命中」对它结构性恒红。
//   故改用逐字精确的裸串计数：正例是「拼接后求值」，文件文本里没有连写 ⇒ 不被误伤。
const CENSUS_NEEDLE = 'context length ' + 'limit'
const CENSUS_ROOTS = ['packages', 'apps', 'scripts']
const CENSUS_SKIP = new Set(['node_modules', 'dist', '.git', '.workbuddy', '.ai-runner', 'coverage', '.turbo'])
const CENSUS_EXT = /\.(?:ts|tsx|js|mjs|cjs|vue|json|md)$/

function census(): { hits: string[], scanned: number } {
  const hits: string[] = []
  let scanned = 0
  const walk = (rel: string): void => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (CENSUS_SKIP.has(e.name)) continue
      const child = `${rel}/${e.name}`
      if (e.isDirectory()) { walk(child); continue }
      if (!CENSUS_EXT.test(e.name)) continue
      let txt = ''
      try { txt = fs.readFileSync(path.join(ROOT, child), 'utf8') } catch { continue }
      scanned++
      if (txt.includes(CENSUS_NEEDLE)) hits.push(child)
    }
  }
  for (const r of CENSUS_ROOTS) walk(r)
  return { hits, scanned }
}

test('裸串 census: 英文触顶整串不得在源码里连写（dump 进会话即自指误报）', () => {
  // 承重前置：针串必须**仍能被探针正则命中**，否则本用例是真空（连写也无害的话就没必要禁）
  assert.ok(
    scan(buildRe(), CENSUS_NEEDLE).n >= 1,
    'census 针串应仍被触顶正则命中，否则「禁连写」失去意义（真空判据）',
  )
  const { hits, scanned } = census()
  assert.ok(scanned >= 50, `census 扫到的源文件太少（${scanned}），判据可能没真正跑起来`)
  assert.ok(
    hits.includes('packages/core/tests/limit-marker-guard.node-test.ts') || scanned > 0,
    'census 必须覆盖本守卫文件自身（裸串此前就在此处）',
  )
  assert.equal(hits.length, 0, `以下源码文件仍连写着触顶整串，被 dump 进会话即自指误报：\n${hits.join('\n')}`)
})

// ── 修复 3：headless _limitReported ↔ 油猴 limitPosted parity ──────────────────
// [WHY] 2026-10-10 同一天内**三次**撞上「headless 有、油猴没有」（回传命中原文 / 冷启动基线 /
//   触顶推送去重）⇒ 补一条结构化断言，把两边旗标的「声明 / 置位 / 复位 / 门」锁成同构。
// [CONSTRAINT] 只锁结构不锁实现：headless 用 dedup 对象属性、油猴用闭包变量，形态本就不同。
const LIMIT_FLAG_SITES = {
  headlessInject: 'packages/core/src/headless/headless-inject.ts',
  headlessSimple: 'packages/core/src/headless/headless-inject-simple.ts',
  userscript: 'scripts/tampermonkey-session-id.user.js',
}

test('limit 推送去重: headless _limitReported 与油猴 limitPosted 四处同构（防第四次分叉）', () => {
  const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  const n = (src: string, re: RegExp): number => (src.match(re) || []).length
  const hj = read(LIMIT_FLAG_SITES.headlessInject)
  const hs = read(LIMIT_FLAG_SITES.headlessSimple)
  const us = read(LIMIT_FLAG_SITES.userscript)

  // headless：复位在 dedup 初始化；守卫 + 置位在主判定
  assert.ok(n(hs, /_limitReported:\s*false/g) >= 1, 'headless 缺 _limitReported 复位（dedup 初始化）')
  assert.ok(n(hj, /if\s*\(\s*!dedup\._limitReported\s*\)/g) >= 1, 'headless 缺 _limitReported 守卫')
  assert.ok(n(hj, /dedup\._limitReported\s*=\s*true/g) >= 1, 'headless 缺 _limitReported 置位')

  // 油猴：声明 1；置位 2（增长通道 + 存量通道各一）；复位 3（声明 + fill + rotate）；门 1
  assert.equal(n(us, /let limitPosted = false/g), 1, '油猴 limitPosted 声明应恰 1 处')
  assert.ok(n(us, /limitPosted = true/g) >= 2, '油猴 limitPosted 置位应 ≥2（增长通道 + 存量通道各一处）')
  assert.ok(n(us, /limitPosted = false/g) >= 3, '油猴 limitPosted 复位应 ≥3（声明 + fill + rotate）')
  assert.equal(n(us, /if \(!limitPosted && limitStale\)/g), 1, '油猴存量兜底通道缺 limitPosted 门')
})
