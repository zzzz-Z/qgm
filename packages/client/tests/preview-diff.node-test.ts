// [preview-diff-v1] 变更预览的数据层判据：弹窗要展示 diff（新增 / 删除），就必须先拿到**两侧**内容。
// [WHY] 这类「取错了另一侧」的缺陷在界面上完全看不出来：before 若被当成空串，整份文件都会渲染成
//   绿色的「全部新增」——一份看起来正常、实际完全错误的 diff。必须用真实请求 + 真实返回值断言。
//   同时对「侧栏宽度」加一条反向锁：宽度联动（SIDE_WIDTH_DIFF）曾让面板在点开预览时跳宽。
// [CONSTRAINT] preview-manager.ts 内部依赖（useToast / log）已全部显式 import，运行期不需要任何全局；
//   各 ref 由调用方注入（最小 ref 替身即可），所以本文件可在纯 node 环境下跑完整取数逻辑。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import type { Ref } from 'vue'
import { beforeEach, describe, expect, test } from 'vitest'
import { createPreviewManager } from '../components/script/preview-manager'

/** 最小 ref 替身：preview-manager 只读写 .value（`Ref` 的符号标记不参与运行期，断言里强转） */
function ref<T>(v: T): Ref<T> {
  return { value: v } as unknown as Ref<T>
}

/** 挂 fetch 替身用（globalThis 无 fetch 类型声明时的写入通道） */
const g = globalThis as unknown as Record<string, unknown>

interface ChangeLite { path: string, type: string, runId?: string }
interface Call { url: string, body: Record<string, unknown> | null }

/** 磁盘态内容（/files/read） */
let afterStore: Record<string, string> = {}
/** 运行前快照（/files/before），key = `${runId}|${file}`；缺项即 exists:false */
let beforeStore: Record<string, { content: string, exists: boolean }> = {}
let calls: Call[] = []
/** [git-diff-hunks-v1] git unified diff 片段；有值时直接走 hunks 分支 */
let gitDiffStore: Record<string, string> = {}
/** 挂住**第一个** before 请求（竞态用例）：返回放行函数 */
let gateFirstBefore: (() => void) | null = null
let gateArmed = false

const json = (o: unknown) => ({ ok: true, json: async () => o })

beforeEach(() => {
  afterStore = {}
  beforeStore = {}
  calls = []
  gitDiffStore = {}
  gateFirstBefore = null
  gateArmed = false
  g.fetch = async (url: string, init?: { body?: string }) => {
    const u = String(url)
    const body = init?.body ? JSON.parse(init.body) as Record<string, unknown> : null
    calls.push({ url: u, body })
    if (u.includes('/git/diff')) {
      // [git-diff-hunks-v1] 默认返回空 diff ⇒ 走回落路径（before/after 快照）；
      //   需要测 hunks 路径的用例通过 gitDiffStore 注入非空 patch
      const f = String((body?.files as string[] | undefined)?.[0] ?? '')
      const p = gitDiffStore[f] ?? ''
      return json({ ok: true, diff: p, filesCount: p ? 1 : 0 })
    }
    if (u.includes('/files/before')) {
      // [gate-by-file-v1] 只挂 A.ts 的 before 请求：加 /git/diff 优先路径后请求顺序可能变，
      //   按「第一个 before」挂可能挂到 B ⇒ 测试锁死。改为按目标文件判，时序无关。
      if (gateFirstBefore && !gateArmed && String(body?.file) === 'A.ts') {
        gateArmed = true
        await new Promise<void>((resolve) => { gateFirstBefore = resolve })
      }
      const key = `${String(body?.runId)}|${String(body?.file)}`
      return json(beforeStore[key] || { content: '', exists: false })
    }
    const p = String((body?.paths as string[] | undefined)?.[0] ?? '')
    return json({ files: [{ path: p, content: afterStore[p] ?? '' }] })
  }
})

/** 造一套依赖面 + 管理器；state 里可直接读各 ref */
function setup(changes: ChangeLite[], runId: string | null = 'run-1') {
  const state = {
    changes: ref(changes),
    result: ref<{ runId?: string } | null>(runId === null ? null : { runId }),
    previewFile: ref<string | null>(null),
    previewType: ref<'added' | 'modified' | 'deleted'>('modified'),
    previewBefore: ref(''),
    previewAfter: ref(''),
    previewBaselineMissing: ref(false),
    previewLoading: ref(false),
    previewHunks: ref<string[]>([]),
  }
  const mgr = createPreviewManager({
    ...state,
    rollback: async () => ({ ok: true }),
    rollbackAll: async () => undefined,
  })
  return { state, mgr }
}

describe('变更预览取数（before / after 两侧）', () => {
  test('modified：两侧都取，before 来自归属轮快照、after 来自磁盘', async () => {
    afterStore['a.ts'] = 'L1\nNEW\nL3\n'
    beforeStore['run-1|a.ts'] = { content: 'L1\nOLD\nL3\n', exists: true }
    const { state, mgr } = setup([{ path: 'a.ts', type: 'modified' }])
    await mgr.onPreviewFile('a.ts')

    const urls = calls.map(c => c.url).sort()
    assert.deepEqual(urls, ['/__ai/files/before', '/__ai/files/read', '/__ai/git/diff'], `请求面不对：${urls.join(', ')}`)
    assert.equal(state.previewBefore.value, 'L1\nOLD\nL3\n', 'before 未写入 ⇒ diff 少一侧，标不出删除')
    assert.equal(state.previewAfter.value, 'L1\nNEW\nL3\n', 'after 未写入 ⇒ diff 少一侧，标不出新增')
    assert.equal(state.previewType.value, 'modified')
    assert.equal(state.previewBaselineMissing.value, false)
    assert.equal(state.previewLoading.value, false, 'loading 未收口 ⇒ 弹窗一直转圈')
  })

  test('added：只取 after，不发 before 请求（新增天然没有变更前内容）', async () => {
    afterStore['n.ts'] = 'brand new\n'
    const { state, mgr } = setup([{ path: 'n.ts', type: 'added' }])
    await mgr.onPreviewFile('n.ts')

    assert.deepEqual(calls.map(c => c.url), ['/__ai/git/diff', '/__ai/files/read'], 'added 不该去拉变更前快照')
    assert.equal(state.previewBefore.value, '', 'before 必须为空 ⇒ 由 changeType 决定整份标为新增')
    assert.equal(state.previewAfter.value, 'brand new\n')
    assert.equal(state.previewType.value, 'added')
    assert.equal(state.previewBaselineMissing.value, false, '新增没有快照是正常的，不该报「快照缺失」')
  })

  test('deleted：只取 before（已删文件读不到当前内容）', async () => {
    beforeStore['run-1|d.ts'] = { content: 'gone\n', exists: true }
    const { state, mgr } = setup([{ path: 'd.ts', type: 'deleted' }])
    await mgr.onPreviewFile('d.ts')

    assert.deepEqual(calls.map(c => c.url), ['/__ai/git/diff', '/__ai/files/before'], 'deleted 不该去读磁盘当前内容')
    assert.equal(state.previewBefore.value, 'gone\n')
    assert.equal(state.previewAfter.value, '', 'after 必须为空 ⇒ 整份标为删除')
    assert.equal(state.previewType.value, 'deleted')
  })

  test('归属轮缺失时退回本轮 runId；两个都没有则不发请求且标缺失', async () => {
    beforeStore['run-1|c.ts'] = { content: 'old\n', exists: true }
    const a = setup([{ path: 'c.ts', type: 'modified' }], 'run-1')
    await a.mgr.onPreviewFile('c.ts')
    assert.equal(a.state.previewBefore.value, 'old\n', '未用本轮 runId 兜底 ⇒ 累积视图预览没有差异')

    const b = setup([{ path: 'c.ts', type: 'modified' }], null)
    calls = [] // 上一半的请求计数必须清空，否则断言会把 a 的请求算进来
    await b.mgr.onPreviewFile('c.ts')
    assert.deepEqual(calls.map(c => c.url), ['/__ai/git/diff', '/__ai/files/read'], '没有 runId 时不该盲发 before 请求')
    assert.equal(b.state.previewBaselineMissing.value, true, '无依据时必须标缺失，不能静默当空')
  })

  test('快照缺失（git 基准 / 被回收）：不伪造「整份新增」，标 baselineMissing 且 before===after', async () => {
    afterStore['g.ts'] = 'keep1\nkeep2\n'
    // beforeStore 里没有该 key ⇒ 服务端返回 exists:false
    const { state, mgr } = setup([{ path: 'g.ts', type: 'modified' }])
    await mgr.onPreviewFile('g.ts')

    assert.equal(state.previewBaselineMissing.value, true, '快照缺失必须被标记 ⇒ 弹窗要写明原因')
    assert.notEqual(state.previewBefore.value, '', '把 before 留空会把整份文件画成绿色「全部新增」——假 diff')
    assert.equal(state.previewBefore.value, state.previewAfter.value, '缺失时应退化为「全上下文行」，零 +/-')
  })

  test('竞态：先点 A 再点 B，A 的迟到响应不得覆盖 B', async () => {
    afterStore['A.ts'] = 'A-after\n'
    afterStore['B.ts'] = 'B-after\n'
    beforeStore['run-1|A.ts'] = { content: 'A-before\n', exists: true }
    beforeStore['run-1|B.ts'] = { content: 'B-before\n', exists: true }
    gateFirstBefore = () => {} // 占位：下面 fetch 会把它换成真正的 resolve
    const { state, mgr } = setup([
      { path: 'A.ts', type: 'modified' },
      { path: 'B.ts', type: 'modified' },
    ])
    const pA = mgr.onPreviewFile('A.ts')
    const pB = mgr.onPreviewFile('B.ts')
    await pB
    assert.equal(state.previewFile.value, 'B.ts')
    const release = gateFirstBefore
    assert.equal(typeof release, 'function', '第一个 before 请求没有被挂住 ⇒ 本用例的竞态前提不成立')
    ;(release as () => void)()
    await pA
    assert.equal(state.previewFile.value, 'B.ts', 'A 的迟到响应把预览切回了 A')
    assert.equal(state.previewAfter.value, 'B-after\n', 'A 的迟到内容覆盖了 B 的 after')
    assert.equal(state.previewBefore.value, 'B-before\n', 'A 的迟到内容覆盖了 B 的 before')
  })

  test('关闭：清空两侧内容并让在途响应作废（迟到响应不复活弹窗）', async () => {
    afterStore['z.ts'] = 'z-after\n'
    beforeStore['run-1|z.ts'] = { content: 'z-before\n', exists: true }
    gateFirstBefore = () => {}
    const { state, mgr } = setup([{ path: 'z.ts', type: 'modified' }])
    const p = mgr.onPreviewFile('z.ts')
    mgr.closePreview()
    assert.equal(state.previewFile.value, null)
    assert.equal(state.previewAfter.value, '')
    assert.equal(state.previewBefore.value, '')
    ;(gateFirstBefore as unknown as () => void)()
    await p
    assert.equal(state.previewFile.value, null, '关闭后迟到响应把弹窗又打开了')
    assert.equal(state.previewBefore.value, '', '关闭后迟到响应写回了内容（下次点新文件会先渲染旧内容）')
  })

  test('同文件再点一次 = 关闭', async () => {
    afterStore['s.ts'] = 'x\n'
    beforeStore['run-1|s.ts'] = { content: 'y\n', exists: true }
    const { state, mgr } = setup([{ path: 's.ts', type: 'modified' }])
    await mgr.onPreviewFile('s.ts')
    assert.equal(state.previewFile.value, 's.ts')
    await mgr.onPreviewFile('s.ts')
    assert.equal(state.previewFile.value, null)
    assert.equal(state.previewAfter.value, '')
  })

  test('未知 type 兜底为 modified（既不假设整份新增，也不假设整份删除）', async () => {
    afterStore['u.ts'] = 'after\n'
    beforeStore['run-1|u.ts'] = { content: 'before\n', exists: true }
    const { state, mgr } = setup([{ path: 'u.ts', type: '' }])
    await mgr.onPreviewFile('u.ts')
    expect(state.previewType.value).toBe('modified')
    assert.equal(state.previewBefore.value, 'before\n')
  })
})

// [side-width-stable-v1] 反向锁：侧栏宽度不得再与预览联动。
// [WHY] 这条缺陷**没有**可循的界面异常：面板只是「自己变宽了一点」，人眼回归看不出来；
//   而它的实现只可能出现在 ScriptPanel 里（往 sideWidth.value 写入）。写死在这里，重新引入必红。
describe('[git-diff-hunks-v1] git diff 优先路径', () => {
  test('git diff 有 patch：走 hunks 分支，不发 before/after 请求', async () => {
    gitDiffStore['a.ts'] = 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n'
    const { state, mgr } = setup([{ path: 'a.ts', type: 'modified' }])
    await mgr.onPreviewFile('a.ts')
    assert.deepEqual(calls.map(c => c.url), ['/__ai/git/diff'], '有 patch 时不该再请求快照')
    assert.equal(state.previewHunks.value.length, 1, 'previewHunks 未设置 ⇒ 弹窗仍空')
    assert.ok(state.previewHunks.value[0].includes('diff --git'), 'patch 内容不对')
    assert.equal(state.previewBaselineMissing.value, false)
    assert.equal(state.previewLoading.value, false, 'loading 未收口')
  })

  test('无 patch：回落 before/after 快照路径', async () => {
    afterStore['b.ts'] = 'L1\nNEW\n'
    beforeStore['run-1|b.ts'] = { content: 'L1\nOLD\n', exists: true }
    const { state, mgr } = setup([{ path: 'b.ts', type: 'modified' }])
    await mgr.onPreviewFile('b.ts')
    assert.equal(state.previewHunks.value.length, 0, '无 patch 时 previewHunks 应为空')
    assert.equal(state.previewBefore.value, 'L1\nOLD\n', '应回落到 before 快照')
    assert.equal(state.previewAfter.value, 'L1\nNEW\n')
  })
})
describe('侧栏宽度不随预览变化（用户指定）', () => {
  const RAW = fs.readFileSync(path.resolve(process.cwd(), 'packages/client/components/script/ScriptPanel.vue'), 'utf8')
  // [comment-strip-guard-v1] 判据是「源码不含某 token」时**必须先剥注释**：否则解释性注释里提到该
  //   token 就让判据假红（本仓已栽过三次：📥 / .awl-item-name / 这里的 SIDE_WIDTH_DIFF）。
  //   只剥整行 `//` 与块注释，不碰字符串内的 `//`（如 'https://…'）。
  const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  test('不得再出现「预览打开时加宽侧栏」的常量与 watch', () => {
    assert.ok(!SRC.includes('SIDE_WIDTH_DIFF'), 'SIDE_WIDTH_DIFF 又回来了 ⇒ 打开预览会把侧栏撑宽')
    assert.ok(!/watch\(\s*previewFile/.test(SRC), '又出现 watch(previewFile) ⇒ 预览会改侧栏宽度')
  })

  test('sideWidth 只允许在一处被写（onMounted 的 localStorage 回填）；拖拽写入归 side-resize.ts', () => {
    const writes = SRC.match(/sideWidth\.value\s*=/g) || []
    assert.equal(
      writes.length,
      1,
      `ScriptPanel 里有 ${writes.length} 处写 sideWidth.value ⇒ 除「挂载回填」外的写入都会让宽度在用户无操作时变化`,
    )
  })
})
