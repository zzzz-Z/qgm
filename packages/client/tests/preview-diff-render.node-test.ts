// @vitest-environment happy-dom
// [preview-diff-render-v1] 变更预览浮层的**真实组件渲染**判据（不是文本正则）。
// [WHY] 「弹窗里到底渲染了什么」是正则测不出的：diff 行数、增删统计、两种模式有没有串台，
//   都只有在真实挂载 + 真 DiffViewer（真 diff 算法）下才成立。
// [CONSTRAINT] FileContentOverlay / DiffViewer 内部全部显式 import（不依赖 unplugin-auto-import），
//   所以本用例不需要往 globalThis 挂 ref/computed —— 若有人把显式 import 换回 auto-import，
//   test:tsc 会先红（Cannot find name），这里也会因运行时缺符号而失败。
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { mount } from '@vue/test-utils'
import { describe, it } from 'vitest'
import FileContentOverlay from '../components/diff/FileContentOverlay.vue'

// 与 aiwin-collapse.node-test.ts 同法：SFC 默认导出在测试里放宽类型，只为拿到 mount 的 props 校验
const OVERLAY = FileContentOverlay as any

/** 挂载浮层；teleport 打桩 ⇒ 内容留在组件树内可直接断言（组件逻辑不变，onMounted 照常执行） */
function render(props: Record<string, unknown>) {
  return mount(OVERLAY, { props, global: { stubs: { teleport: true } } })
}

const MODIFIED = { fileName: 'a.ts', before: 'L1\nOLD\nL3\n', after: 'L1\nNEW\nL3\n', changeType: 'modified' }

describe('变更预览浮层：diff 渲染', () => {
  it('modified ⇒ 渲染出「新增行」与「删除行」，并给出 +N/−M 统计', () => {
    const w = render(MODIFIED)
    const adds = w.findAll('.diff-line.add')
    const dels = w.findAll('.diff-line.del')
    assert.equal(adds.length, 1, '没有渲染新增行 ⇒ 用户看不到这一轮加了什么')
    assert.match(adds[0].text(), /NEW/, '新增行内容不对')
    assert.equal(dels.length, 1, '没有渲染删除行 ⇒ 用户看不到这一轮删了什么')
    assert.match(dels[0].text(), /OLD/, '删除行内容不对')
    const stats = w.find('.diff-stats').text()
    assert.match(stats, /\+1/, `缺新增计数（实际 ${stats}）`)
    assert.match(stats, /-1/, `缺删除计数（实际 ${stats}）`)
    // 表头仍是 DiffViewer 的（文件名 + 类型徽标），不是另起一套
    assert.match(w.find('.diff-header').text(), /a\.ts/)
    assert.match(w.find('.diff-badge').text(), /MODIFIED/)
  })

  it('added / deleted 是整份标色：新增全绿、删除全红', () => {
    const added = render({ fileName: 'n.ts', before: '', after: 'x\ny\n', changeType: 'added' })
    assert.ok(added.findAll('.diff-line.add').length >= 2, 'added 未整份标为新增')
    assert.equal(added.findAll('.diff-line.del').length, 0, 'added 不该出现删除行')

    const deleted = render({ fileName: 'd.ts', before: 'x\ny\n', after: '', changeType: 'deleted' })
    assert.ok(deleted.findAll('.diff-line.del').length >= 2, 'deleted 未整份标为删除')
    assert.equal(deleted.findAll('.diff-line.add').length, 0, 'deleted 不该出现新增行')
  })

  it('loading ⇒ 显示占位，且不渲染 diff（别把空内容当「无变更」）', () => {
    const w = render({ fileName: 'a.ts', loading: true, before: '', after: '', changeType: 'modified' })
    assert.ok(!w.find('.diff-viewer').exists(), '加载中就渲染了 diff ⇒ 会先闪一屏「无内容变更」')
    assert.match(w.text(), /加载中/, '缺加载占位')
  })

  it('baselineMissing ⇒ 显式说明「无变更前快照」，不装作 diff 正常', () => {
    const w = render({ ...MODIFIED, before: MODIFIED.after, baselineMissing: true })
    const note = w.find('.fco-note')
    assert.ok(note.exists(), '快照缺失没有任何说明 ⇒ 用户会把「全是上下文行」读成「没有改动」')
    assert.match(note.text(), /变更前快照/)
  })
})

describe('变更预览浮层：关闭通道与模式隔离', () => {
  it('× 按钮 / Esc / 点遮罩 三个通道都派发 close', async () => {
    const w = render(MODIFIED)
    await w.find('.fco-btn').trigger('click')
    assert.equal(w.emitted('close')?.length, 1, '× 按钮没派发 close')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    assert.equal(w.emitted('close')?.length, 2, 'Esc 没派发 close')
    await w.find('.fco-mask').trigger('click')
    assert.equal(w.emitted('close')?.length, 3, '点遮罩没派发 close')
  })

  it('mode="content"（工作日志预览）⇒ 只看当前内容，不渲染 diff', () => {
    const w = render({ fileName: 'a.md', mode: 'content', content: '# 标题\n\n正文\n' })
    assert.ok(!w.find('.diff-viewer').exists(), 'content 模式渲染了 diff ⇒ 两种模式串台')
    assert.ok(w.find('.fco-md').exists(), 'markdown 文件没走 md 渲染分支')
    assert.match(w.find('.fco-md').html(), /标题/, '内容没渲染出来')
    assert.ok(w.find('.fco-path').exists(), 'content 模式缺文件名表头（diff 模式的表头在 DiffViewer 内）')

    const plain = render({ fileName: 'a.ts', mode: 'content', content: 'const a = 1\n' })
    assert.ok(plain.find('.fco-pre').exists(), '非 md 文件没走 <pre> 分支')
  })

  it('工作日志侧显式声明 mode="content"（默认值换成 diff 也不会串台）', () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'packages/client/components/panels/WorklogPane.vue'), 'utf8')
    assert.match(src, /mode="content"/, 'WorklogPane 没钉住 content 模式 ⇒ 浮层默认模式一变它就被改成 diff')
  })
})

// [close-overlay-badge-fix] 关闭按钮绝对定位在卡片右上，表头必须自己留出右侧空间。
// [WHY] 这条契约曾在 DiffOverlay 上静默失效：宿主用 CSS 变量穿透 padding，而 DiffViewer 从未读该变量，
//   结果关闭按钮压住表头徽标/统计 —— 单测与 e2e 都不会红（纯视觉）。scoped 样式在 vitest 下不注入，
//   只能对源码做契约断言。
describe('浮层表头给关闭按钮留位（源码契约）', () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8')

  it('DiffViewer 表头读 --diff-header-pr（宿主注入的右侧内边距）', () => {
    assert.match(
      read('packages/client/components/diff/DiffViewer.vue'),
      /var\(--diff-header-pr/,
      'DiffViewer 没读 --diff-header-pr ⇒ 关闭按钮会压住徽标/统计',
    )
  })

  it('FileContentOverlay 声明该变量（40px = 按钮 24 + right 8 + 间隙 8）', () => {
    assert.match(
      read('packages/client/components/diff/FileContentOverlay.vue'),
      /--diff-header-pr:\s*40px/,
      '浮层没声明 --diff-header-pr ⇒ 表头右侧空间与按钮尺寸脱钩',
    )
  })
})
