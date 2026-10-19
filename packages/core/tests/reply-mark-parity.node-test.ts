// [reply-mark-v1] 守卫：`SCRIPT` / `ASK` / `DONE` / `HANDOFF` / `TEXT` 五类标记的判据，三处实现必须逐例一致。
//
// 背景：四类回复原先各写各的判据 —— SCRIPT 靠 DOM 结构 + 语言标签猜（根本没有标记行），
// ASK 在浏览器侧只看首行前缀、前端却用带 m 标志的正则（任意行），DONE 只认首行精确。
// 后果实测（.ai-runner/tmp/probe-ask-parity.mjs）：同一条回复在不同链路被分到不同类别，
// 「先说理再提问」在浏览器侧被判非标记、又无代码块 → plain 门槛 return null → 整轮静默丢弃。
//
// 现统一为「首个非空行 = 独占一行的标记行，第二行起才是载荷」。
// 本守卫不比对文本相似度：它把三处 scanReplyMarks 的**花括号内部**抠出来分别编译执行，
// 对同一批样例真跑对拍。三处输出必须逐例相同；同时断言期望值，防止「三处一起改错」。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import vm from 'node:vm'

const ROOT = process.cwd()
const BROWSER_SRC = 'packages/core/src/headless/headless-inject.ts'
const CLIENT_SRC = 'packages/client/utils/reply-mark.ts'
const TAMPERMONKEY_SRC = 'scripts/tampermonkey-session-id.user.js'

/** 三处内联副本：headless 注入 / 前端解析 / 油猴通道（page.evaluate 与用户脚本都无法共享模块） */
const SOURCES = [BROWSER_SRC, CLIENT_SRC, TAMPERMONKEY_SRC]

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

/**
 * 抠出 `function <name>(...) { <inner> }` 的花括号内部
 * [WHY] 三处签名都带 TS 类型注解（strict 下必需），整段编译会语法错；
 *   函数内部刻意不写注解（见源文件 CONSTRAINT），因此只取内部即可直接编译。
 * [CONSTRAINT] 要求签名里不含花括号（返回类型不能用内联对象字面量），否则会被误当函数体起点
 */
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
    } else if (c === '}') {
      depth -= 1
      if (depth === 0) return src.slice(braceAt + 1, i)
    }
  }
  throw new Error(`${name} 花括号不配平`)
}

interface Scan { script: number, ask: number, done: number, handoff: number, text: number }

/** 编译出可执行的 scanReplyMarks（源码即被测对象，改了源码这里立刻变红） */
function buildScanner(rel: string): (md: string) => Scan {
  const inner = extractInner(read(rel), 'scanReplyMarks')
  // 用 vm 而非 new Function：被测源码当数据处理，编译产物拿不到本测试的闭包与宿主作用域
  const fn = vm.runInNewContext(`(function (md) { ${inner} })`, {}) as (md: string) => Scan
  // [cross-realm-flatten] vm 新建 realm，返回对象的原型来自另一个 Object.prototype，
  // 直接交给 assert.deepEqual（= deepStrictEqual）会因原型不同而失败，且报错信息是
  // 「Compared values have no visual difference」——极难排查。此处展平成当前 realm 的普通对象。
  return (md: string) => {
    const r = fn(md)
    return { script: r.script, ask: r.ask, done: r.done, handoff: r.handoff, text: r.text }
  }
}

interface Case { name: string, md: string, expect: Scan }

const NONE: Scan = { script: -1, ask: -1, done: -1, handoff: -1, text: -1 }
const only = (k: keyof Scan, line: number): Scan => ({ ...NONE, [k]: line })

const CASES: Case[] = [
  // ── 正常形态：首行标记行 + 第二行起载荷 ──
  {
    name: 'SCRIPT 首行 + 代码块',
    md: 'SCRIPT\n\n```js\n#! /usr/bin/env node\n// @desc 读文件\n```',
    expect: only('script', 1),
  },
  {
    name: 'ASK 首行 + 正文',
    md: 'ASK\n请选择目标：\n\n- 方案 A\n- 方案 B',
    expect: only('ask', 1),
  },
  {
    name: 'DONE 首行 + 总结',
    md: 'DONE\n\n## 总结\n\n已完成三处修改。',
    expect: only('done', 1),
  },
  {
    name: 'HANDOFF 首行 + 摘要',
    md: 'HANDOFF\n\n# 任务\n轮转摘要如下。',
    expect: only('handoff', 1),
  },
  {
    name: 'TEXT 首行 + 纯文本正文（新增：显式纯文本回执）',
    md: 'TEXT\n\n诊断结果：三处模块均已加载，无需改动。',
    expect: only('text', 1),
  },
  {
    name: 'TEXT 正文含列表仍只认首行标记',
    md: 'TEXT\n现状如下：\n\n- 技能 15 个\n- 漂移 0 项',
    expect: only('text', 1),
  },
  {
    name: '标记前允许空行（仍算首行）',
    md: '\n\n  DONE  \n总结正文',
    expect: only('done', 3),
  },
  // ── 形态约束：必须独占一行 ──
  {
    name: '`ASK 问题` 同行写法不命中（必须换行写载荷）',
    md: 'ASK 请选择目标：\n\n- 方案 A',
    expect: NONE,
  },
  {
    name: '`SCRIPT 说明` 同行写法不命中',
    md: 'SCRIPT 下面是我的脚本\n```js\nconst a = 1\n```',
    expect: NONE,
  },
  {
    name: '标记后跟其他词不命中',
    md: 'DONE 之后就不再有输出。',
    expect: NONE,
  },
  {
    name: '`TEXT 说明` 同行写法不命中（标记必须独占一行）',
    md: 'TEXT 下面是我的说明\n\n正文若干。',
    expect: NONE,
  },
  // ── 位置约束：只认首行 ──
  {
    name: '标记出现在第 3 行不命中（先说理再提问要改成 ASK 开头）',
    md: '通道确认：我需要你决策。\n现状已列在下面。\nASK\n- 推送\n- 等待',
    expect: NONE,
  },
  {
    name: '正文里引用 DONE 二字不命中',
    md: '关于 DONE 的说明\n\nDONE 之后就不再有输出。',
    expect: NONE,
  },
  {
    name: '围栏内的标记不命中',
    md: '示例：\n\n```text\nDONE\n```',
    expect: NONE,
  },
  {
    name: '列表项里的标记不命中',
    md: '- ASK 这不是首行标记',
    expect: NONE,
  },
  {
    name: '纯问候语（应被 plain 门槛过滤）',
    md: '好的，我明白了。',
    expect: NONE,
  },
  // ── 大小写：纯大写英文单词 ──
  {
    name: '小写 script 不命中（契约规定大写）',
    md: 'script\n```js\nconst a = 1\n```',
    expect: NONE,
  },
  {
    name: '小写 text 不命中（契约规定大写）',
    md: 'text\n\n正文若干。',
    expect: NONE,
  },
  // ── 别名已移除（[alias-removed-v1] 2026-10-07）：旧写法不再命中 ──
  {
    name: '旧别名 `@ask` 已移除，不命中',
    md: '@ask\n请确认要用哪个方案？',
    expect: NONE,
  },
  {
    name: '旧别名 `# 任务` 已移除，不命中',
    md: '# 任务\n\n# 已完成\n- 若干',
    expect: NONE,
  },
  {
    name: '旧别名 @ask 后跟正文也不命中',
    md: '@ask 请确认要用哪个方案？',
    expect: NONE,
  },
]

test('reply-mark: 三处判据对同一批样例输出逐例一致', () => {
  const scanners = SOURCES.map(rel => ({ rel, scan: buildScanner(rel) }))
  for (const c of CASES) {
    for (let i = 1; i < scanners.length; i++) {
      assert.deepEqual(
        scanners[i].scan(c.md),
        scanners[0].scan(c.md),
        `样例「${c.name}」：${scanners[i].rel} 与 ${scanners[0].rel} 判据不一致`,
      )
    }
  }
})

test('reply-mark: 判据结果符合预期（防三处同错）', () => {
  const client = buildScanner(CLIENT_SRC)
  for (const c of CASES) {
    assert.deepEqual(client(c.md), c.expect, `样例「${c.name}」结果不符预期`)
  }
})

// ============ 结构断言：统一不得回退成「各判各的」 ============

test('reply-mark: 三处实现都锚定首个非空行，且五类标记齐全', () => {
  for (const rel of SOURCES) {
    const inner = extractInner(read(rel), 'scanReplyMarks')
    assert.ok(/lines\[head\]\.trim\(\)/.test(inner), `${rel} 未锚定首个非空行（应取 lines[head].trim()）`)
    for (const literal of ['/^SCRIPT$/', '/^ASK$/', '/^DONE$/', '/^HANDOFF$/', '/^TEXT$/']) {
      assert.ok(inner.includes(literal), `${rel} 的 scanReplyMarks 缺少标记判据 ${literal}`)
    }
    // [CONSTRAINT] 断言完整字面量而非变量名：变异验证发现只查「变量还在」时，删掉判据那一行守卫仍全绿
    assert.ok(
      !inner.includes('@ask\\b'),
      `${rel} 的 ASK 判据仍是行首前缀（@ask\\b）→ 与 DONE 的独占语义不一致`,
    )
  }
})

test('reply-mark: 浏览器侧 plain 门槛必须复用首行标记扫描', () => {
  const src = read(BROWSER_SRC)
  assert.ok(!src.includes('isAskPrefix'), 'isAskPrefix（只看首行前缀）应已被 scanReplyMarks 取代')
  assert.ok(
    src.includes('scanReplyMarks(extractReplyMd(replyRoot))'),
    'plain 门槛应基于首行标记扫描的结果（DOM→Markdown 反推，保留换行）',
  )
  assert.ok(src.includes('marks.ask < 0 && marks.handoff < 0'), 'plain 门槛应复用 marks，不得另起一套判据')
  // [text-mark-v1] 显式 TEXT 标记必须能穿过 plain 门槛，否则「加一个纯文本回复类型」等于没加
  assert.ok(src.includes('&& marks.text < 0'), 'TEXT 标记的回复必须能穿过 plain 门槛（否则显式纯文本仍被丢弃）')
  assert.ok(
    !src.includes('scanReplyMarks(plainText)'),
    '不得对 getMainText() 的 textContent 做标记扫描：它无换行，整段被当一行，首行判据必然失配',
  )
})

// [script-fence-guess-removed-v1] 旧「按围栏猜脚本」通道已彻底删除，原两条用例（标记让位 / 白名单同构）
// 断言的对象已不存在。新架构下脚本意图只由 turn 信封 content[].type 决定，不再有围栏语言猜测。

test('reply-mark: findNewDone 不得退回自写的首行 DONE 判据', () => {
  const src = read(BROWSER_SRC)
  assert.ok(src.includes('scanReplyMarks(full).done'), 'findNewDone 应使用统一扫描')
  assert.ok(
    !src.includes('/^\\s*DONE\\s*$/.test(firstLine)'),
    'findNewDone 保留自写的「首行严格 DONE」判据 → 与统一判据两套并行，会再次漂移',
  )
})

test('reply-mark: 油猴通道同样不得自写判据', () => {
  const src = read(TAMPERMONKEY_SRC)
  assert.ok(src.includes('scanReplyMarks(summary).done'), '油猴 findNewDone 应使用统一扫描')
  // [script-fence-guess-removed-v1] 旧「脚本分类让位于标记」的三元/if 分支已整体删除（含 extractLatestScript 调用）。
  //   本断言改为守护「旧通道不复活」——一旦回来，正文里的示例代码又会被真执行。
  // [script-fence-guess-removed-v1] 判活调用而非文本出现：注释里提到函数名不算复活。
  const activeLines = src.split(String.fromCharCode(10)).filter((l) => {
    const t = l.trim()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/**')
  }).join(String.fromCharCode(10))
  assert.ok(
    !/extractLatestScript\s*\(/.test(activeLines),
    '油猴通道仍调用 extractLatestScript → 按围栏猜脚本的旧通道被复活了',
  )
  assert.ok(
    !src.includes('/^\\s*DONE\\s*$/.test(firstLine)'),
    '油猴通道保留自写的「首行严格 DONE」判据 → 走该通道时行为与主链路分叉',
  )
})

test('reply-mark: 前端 parseAsk 必须复用同一套扫描', () => {
  const src = read('packages/client/utils/ask-parser.ts')
  assert.ok(src.includes('scanReplyMarks(raw)'), 'parseAsk 应基于 scanReplyMarks 定位标记行')
  assert.ok(!src.includes('ASK_HEAD_RE'), '旧的 ASK_HEAD_RE（m flag、任意行）应已移除')
  assert.ok(src.includes('.slice(scan.ask)'), '正文应从标记行的下一行起（slice(scan.ask)）')
})

// [no-root-no-reply-v1] 页面无 assistant 容器（新会话首轮「已思考/搜索」期）时禁止整页兜底提取。
// [WHY] 2026-10-08 18:53 截图实测：新窗口首问，DeepSeek 思考面板流式期间尚无
//   .ds-assistant-message-main-content，「|| document / : document」兜底把侧栏历史会话标题
//   （未知标签递归 inner() 拼成连体乱文）+ 用户首条消息卡（SYSTEM.md）反推成「回复」，
//   思考面板每稳定一拍 bodySignature 变一次 → plain 分支连推数张噪音文本卡。
//   [CONSTRAINT] 本断言针对两个采集通道的**兜底字面量**；bodySignature 里的
//   「容器文本缺失退回整页签名」是另一码事（只作变化信号、不外发正文），不在禁止之列。
test('reply-mark: 无 assistant 容器时禁止整页兜底提取（两通道同构守卫）', () => {
  for (const rel of [BROWSER_SRC, TAMPERMONKEY_SRC]) {
    const src = read(rel)
    assert.ok(
      !src.includes('latestAssistantRoot() || document'),
      `${rel} 仍把「无 assistant 容器」兜底成整页 document（新会话思考期噪音根因，2026-10-08）`,
    )
    assert.ok(
      !src.includes('blocks.length > 0 ? blocks[blocks.length - 1] : document'),
      `${rel} 仍把「无 assistant 容器」兜底成整页 document（新会话思考期噪音根因，2026-10-08）`,
    )
  }
})
