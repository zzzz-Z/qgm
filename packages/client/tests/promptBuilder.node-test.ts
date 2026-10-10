// [p3-4-fingerprint-visible-v1] appendFingerprints 守卫：AST 指纹必须真能渲染进回填 prompt。
// [test-skip-reason-v1] appendFeedbackSummary 守卫：「没跑单测」不得被显示成「通过」。
// [fence-safe-v1] 回填围栏守卫：固定三反引号会被**内容自身**撑破（Channel C），无围栏的源码块
//   会被页面探针当成普通文本扫到（Channel D）——两者都会让「工作台把探针自己的词表喂回会话」
//   变成误报触顶并掐掉一整轮（2026-10-10 12:02 实锤）。判据不是「fenceFor 返回了更长的串」
//   （那是实现细节），而是**按 markdown 围栏语义切块后内容仍完整落在一个块内**。
// 纯函数、无 DOM / 无网络依赖（仅 appendFailedSourceFiles 需 stub fetch），适合在 node 环境直接锁定行为。
import { it, vi } from 'vitest'
import assert from 'node:assert/strict'
import { createTreeAttach } from '../components/script/tree-attach.js'
import {
  appendChangeList,
  appendFailedSourceFiles,
  appendFeedbackSummary,
  appendFingerprints,
  appendLintReport,
  appendRawOutputs,
  appendTestReport,
  appendTscReport,
  fenceFor,
  pushFenced,
} from '../components/script/prompt-builder.js'

it('appendFingerprints：无指纹 / 空数组时不产出任何块', () => {
  const cases: Array<Parameters<typeof appendFingerprints>[1]> = [
    null,
    { ok: false, code: 1 },
    { ok: false, code: 1, fingerprints: [] },
  ]
  for (const r of cases) {
    const p: string[] = []
    appendFingerprints(p, r)
    assert.equal(p.length, 0)
  }
})

it('appendFingerprints：有指纹时产出「文件 | 行 | 符号 | 类别」', () => {
  const p: string[] = []
  appendFingerprints(p, {
    ok: false,
    code: 1,
    fingerprints: [
      { file: 'packages/client/components/script/exec-flow.ts', line: 50, symbol: 'createExecFlow', kind: 'function' },
    ],
  })
  const text = p.join('\n')
  assert.match(text, /# 失败定位（AST 指纹）/)
  assert.match(text, /packages\/client\/components\/script\/exec-flow\.ts \| 50 \| `createExecFlow` \| function/)
})

it('appendFeedbackSummary：无测试目标时显式说明「未运行」，且不得出现 test ✓', () => {
  const p: string[] = []
  appendFeedbackSummary(p, {
    ok: true,
    code: 0,
    test: { ran: false, ok: true, reason: 'no-test-targets' },
  })
  const text = p.join('\n')
  assert.match(text, /本轮未运行单测（无测试目标）/)
  assert.doesNotMatch(text, /test ✓/)
})

it('appendFeedbackSummary：真正跑过并通过时才出现 test ✓', () => {
  const p: string[] = []
  appendFeedbackSummary(p, { ok: true, code: 0, test: { ran: true, ok: true } })
  const text = p.join('\n')
  assert.match(text, /test ✓/)
  assert.doesNotMatch(text, /本轮未运行单测/)
})

// ─────────── [fence-safe-v1] 围栏自适应：Channel C / Channel D ───────────

/**
 * 按 markdown 围栏语义切成代码块：返回每块的「围栏串 + 体」。
 * 存在**未闭合**围栏（内容把自己的围栏撑破）时返回 null —— 这就是本组用例的失败信号。
 * [CONSTRAINT] 闭合判据取「同字符且长度 ≥ 开栏」，与 CommonMark 一致；内容里出现 >= 开栏长度的
 *   反引号串即被误判为闭合 —— 正是我们要抓的形态（所以这条判据是承重的，不是形式化的）。
 */
function parseFences(text: string): Array<{ fence: string, body: string }> | null {
  const blocks: Array<{ fence: string, body: string }> = []
  let open: string | null = null
  let buf: string[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(`{3,})[^`]*$/.exec(line)
    if (open === null) {
      if (m) { open = m[1]; buf = [] }
      continue
    }
    if (m && m[1].length >= open.length) {
      blocks.push({ fence: open, body: buf.join('\n') })
      open = null
      buf = []
      continue
    }
    buf.push(line)
  }
  return open === null ? blocks : null
}

/** 断言「整段输出没有未闭合围栏」，并返回所有块体 */
function closedBlocks(text: string, label: string): string[] {
  const blocks = parseFences(text)
  assert.ok(blocks, `${label}: 围栏未闭合 —— 内容把自己的围栏撑破了（Channel C 回归）`)
  return blocks.map(b => b.body)
}

it('fenceFor：围栏长度随内容里最长反引号串自适应（无围栏需求时仍是三反引号）', () => {
  assert.equal(fenceFor('no backticks here'), '```', '内容无反引号时应保持既有三反引号形态')
  assert.equal(fenceFor('a ``` b'), '````', '出现三反引号 ⇒ 外层必须至少四个')
  assert.equal(fenceFor('a ``` b ```` c'), '`````', '取最长串 + 1')
  assert.equal(fenceFor(''), '```')
})

it('pushFenced：内容自带三反引号时围栏不被撑破，内容原样留在一个块内', () => {
  const payload = ['readText 输出:', '```js', 'const x = 1', '```', 'TAIL-MARKER'].join('\n')
  const p: string[] = []
  pushFenced(p, payload)
  const bodies = closedBlocks(p.join('\n'), 'pushFenced')
  assert.equal(bodies.length, 1, '内容必须留在**一个**块内，而不是被截成两段')
  assert.equal(bodies[0], payload, '内容须原样落在块内（不转义、不截断）')
})

/** 12:02 实况：被 dump 的源码里就有探针自己的触顶词表 */
const MARKER_VOCAB = 'maximum context length'

it('appendRawOutputs：stdout 含三反引号与探针词表时，词表必须落在围栏内（Channel C 承重）', () => {
  const stdout = ['$ readText x.ts | head -136', '```ts', `// ${MARKER_VOCAB}`, '```', 'done'].join('\n')
  const p: string[] = []
  appendRawOutputs(p, { ok: true, code: 0, stdout, stderr: `err\n\`\`\`\n${MARKER_VOCAB}\n\`\`\`` })
  const text = p.join('\n')
  const bodies = closedBlocks(text, 'appendRawOutputs')
  assert.ok(
    bodies.some(b => b.includes(MARKER_VOCAB)),
    'stdout 里的探针词表必须落在围栏内：否则页面里落成普通文本，探针自指命中 ⇒ 误报触顶',
  )
  assert.match(text, /^# Stdout$/m, '块标题形态保持不变')
  assert.match(text, /^# 错误输出 \(stderr\)$/m, 'stderr 块标题形态保持不变')
})

it('appendTscReport / appendLintReport / appendTestReport：含反引号的输出不得撑破围栏', () => {
  const noisy = ['错误信息里带代码围栏:', '```', `${MARKER_VOCAB}`, '```', '结尾'].join('\n')
  const cases: Array<[string, (p: string[]) => void]> = [
    ['appendTscReport', p => appendTscReport(p, { ok: false, code: 1, tsc: { ok: false, stdout: noisy, stderr: noisy } })],
    ['appendLintReport', p => appendLintReport(p, { ok: false, code: 1, lint: { ran: true, ok: false, stdout: noisy, stderr: noisy } })],
    ['appendTestReport', p => appendTestReport(p, { ok: false, code: 1, test: { ran: true, ok: false, stdout: noisy, stderr: noisy } })],
  ]
  for (const [label, run] of cases) {
    const p: string[] = []
    run(p)
    const bodies = closedBlocks(p.join('\n'), label)
    assert.ok(
      bodies.some(b => b.includes(MARKER_VOCAB)),
      `${label}: 输出里的探针词表必须落在围栏内`,
    )
  }
})

it('appendChangeList：条目行不带反引号 ⇒ 维持三反引号形态（AI 侧无感）', () => {
  const p: string[] = []
  appendChangeList(p, [{ type: 'modified', path: 'a.ts' }, { type: 'added', path: 'b.ts' }])
  const text = p.join('\n')
  assert.match(text, /^```$/m, '普通条目不应触发加长围栏')
  assert.match(text, /^modified a\.ts$/m)
  assert.match(text, /^added b\.ts$/m)
})

// [fence-safe-v1] Channel D 的**第二个发射点**：附件正文（拖入编辑器的文件/目录内容）。
// [WHY] 附件与 `# 相关文件源码` 同属「源码原样进 prompt」这一条通道；不围栏时它落进页面是普通文本，
//   页面内触顶探针扫得到其中的探针词表（用户拖进 `headless-inject*.ts` 自己那份源码即命中）⇒
//   自指误报「已达长度上限」并掐掉一整轮。项目铁律「修被隐藏的机制先数入口」：只堵一处 = 没修完。
// 判据承重点：不是「有没有调用 pushFenced」（实现细节），而是**切块后词表确实落在围栏内**。
type AttachDeps = Parameters<typeof createTreeAttach>[0]

// [CONSTRAINT] `fmtSize` 是 auto-import 全局（`auto-imports.d.ts` 里以 `declare global { const … }` 声明），
//   node 测试不经 unplugin-auto-import 变换 ⇒ 该裸标识符在运行时**未绑定**，直接调用抛
//   `ReferenceError: fmtSize is not defined`。故必须显式补全局桩。
//   桩只影响「附件标题里的体积串」，与「围栏是否承重」这一判据无关（标题形态另有用例钉住）。
function stubFmtSize(): void {
  vi.stubGlobal('fmtSize', (bytes: number) => `${bytes}B`)
}

it('buildPromptWithAttachments：text 附件正文必须落在围栏内（Channel D 第二入口）', async () => {
  stubFmtSize()
  try {
    const { buildPromptWithAttachments } = createTreeAttach({ value: [] } as unknown as AttachDeps)
    const content = ['export const a = 1', '```', `// ${MARKER_VOCAB}`, '```', 'export const b = 2'].join('\n')
    const out = await buildPromptWithAttachments('# SCRIPT\n', [
      { id: 'at1', name: 'a.ts', size: content.length, kind: 'text', content },
    ] as unknown as Parameters<typeof buildPromptWithAttachments>[1])
    const bodies = closedBlocks(out, 'attachment(text)')
    const inside = bodies.filter(b => b.includes(MARKER_VOCAB))
    assert.equal(inside.length, 1, '附件正文里的探针词表必须落在围栏内（原先无围栏 ⇒ 落成普通文本被探针扫到）')
    assert.ok(inside[0].includes('export const a = 1'), '附件正文须原样保留（不转义、不截断）')
    assert.match(out, /^═════ 附件 a\.ts \(.*\) ═════$/m, '附件标题形态保持不变（AI 侧靠它识别附件边界）')
    assert.match(out, /^# SCRIPT$/m, '脚本文本仍接在附件之后')
  } finally {
    vi.unstubAllGlobals()
  }
})

it('buildPromptWithAttachments：目录附件正文也必须落在围栏内，且分隔行契约不变', async () => {
  const origFetch = globalThis.fetch
  const content = ['l1', '```', `// ${MARKER_VOCAB}`, '```'].join('\n')
  globalThis.fetch = (async () => ({
    json: async () => ({ files: [{ path: 'x.ts', content }] }),
  })) as unknown as typeof fetch
  try {
    const { buildPromptWithAttachments } = createTreeAttach({ value: [] } as unknown as AttachDeps)
    const out = await buildPromptWithAttachments('', [
      { id: 'at2', name: 'dir', size: 1, kind: 'folder', content: '', paths: ['x.ts'] },
    ] as unknown as Parameters<typeof buildPromptWithAttachments>[1])
    const bodies = closedBlocks(out, 'attachment(folder)')
    const inside = bodies.filter(b => b.includes(MARKER_VOCAB))
    assert.equal(inside.length, 1, '目录附件正文必须落在围栏内（同一通道的第二个分支）')
    assert.ok(inside[0].includes('----- x.ts -----'), '`----- path -----` 分隔行必须逐字符保留且落在围栏内')
    assert.match(out, /^═════ 附件目录 dir \(1 文件\) ═════$/m, '目录附件标题（含收尾 ═════）形态保持不变')
  } finally {
    globalThis.fetch = origFetch
  }
})

it('appendFailedSourceFiles：# 相关文件源码 段落必须落在围栏内（Channel D 承重）', async () => {
  const origFetch = globalThis.fetch
  const source = ['export const a = 1', '```', `// ${MARKER_VOCAB}`, '```'].join('\n')
  globalThis.fetch = (async () => ({
    json: async () => ({ files: [{ path: 'packages/core/src/x.ts', content: source }] }),
  })) as unknown as typeof fetch
  try {
    const p: string[] = []
    await appendFailedSourceFiles(
      p,
      { ok: false, code: 1, errorFiles: ['packages/core/src/x.ts'] },
      [],
      { stripComments: false, stripBlankLines: false, errorLocs: new Map() },
    )
    const text = p.join('\n')
    assert.match(text, /^# 相关文件源码（失败时自动附加，含报错涉及的文件）$/m)
    const bodies = closedBlocks(text, 'appendFailedSourceFiles')
    const inside = bodies.filter(b => b.includes('<file path="packages/core/src/x.ts"'))
    assert.equal(
      inside.length,
      1,
      '源码块必须落在围栏内 —— 原先无围栏时它落成普通文本，被页面探针扫到 ⇒ 自指误报（Channel D）',
    )
    assert.ok(inside[0].includes('1| export const a = 1'), '<file path=…> 与 `N| ` 行号契约须逐字符不变')
    assert.ok(inside[0].includes(`3| // ${MARKER_VOCAB}`), '被 dump 的源码行整体在块内（含探针词表那行）')
  } finally {
    globalThis.fetch = origFetch
  }
})
