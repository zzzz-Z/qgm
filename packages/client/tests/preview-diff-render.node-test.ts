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
import { beforeAll, describe, it } from 'vitest'
import FileContentOverlay from '../components/diff/FileContentOverlay.vue'
import DiffViewer from '../components/diff/DiffViewer.vue'

// [preview-diff-render-canvas-stub-v1] @git-diff-view 的 TextMeasure 用 canvas 2d context 做字体测量；
//   happy-dom 不实现该 API（getContext('2d') 恒 null）⇒ 组件挂载即抛 TypeError，所有渲染断言跟着红。
//   只打桩 2d context，其余类型走原实现，避免误伤其他路径。
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = function (type: string) {
    if (type === '2d') {
      return {
        font: '',
        measureText: (s: string) => ({ width: String(s).length * 6 }),
        fillText: () => {},
        save: () => {},
        restore: () => {},
      }
    }
    return null
  } as unknown as typeof HTMLCanvasElement.prototype.getContext
})

// 与 aiwin-collapse.node-test.ts 同法：SFC 默认导出在测试里放宽类型，只为拿到 mount 的 props 校验
const OVERLAY = FileContentOverlay as any

/** 挂载浮层；teleport 打桩 ⇒ 内容留在组件树内可直接断言（组件逻辑不变，onMounted 照常执行） */
function render(props: Record<string, unknown>) {
  return mount(OVERLAY, { props, global: { stubs: { teleport: true } } })
}

const MODIFIED = { fileName: 'a.ts', before: 'L1\nOLD\nL3\n', after: 'L1\nNEW\nL3\n', changeType: 'modified' }

describe('变更预览浮层：diff 渲染', () => {
  it('modified ⇒ 两侧内容与类型正确传给 DiffViewer，表头展示文件名与徽标', () => {
    const w = render(MODIFIED)
    // 库（@git-diff-view）在 happy-dom 下不渲染行级 DOM（TextMeasure 缺 canvas 2d），
    // 断言下沉到宿主契约层：真正的风险是「before/after 被吞」→ 整份文件错算成全新增。
    const dv = w.findComponent(DiffViewer)
    assert.ok(dv.exists(), '未渲染 DiffViewer')
    assert.equal(dv.props('before'), MODIFIED.before, 'before 未传对 ⇒ 整份文件会被算成新增')
    assert.equal(dv.props('after'), MODIFIED.after, 'after 未传对')
    assert.equal(dv.props('fileName'), 'a.ts')
    assert.equal(dv.props('changeType'), 'modified')
    assert.match(w.find('.diff-header').text(), /a\.ts/)
    assert.match(w.find('.diff-badge').text(), /MODIFIED/)
  })

  it('added / deleted 走 changeType 口径传给 DiffViewer（归空在库侧，宿主只传原值与口径）', () => {
    const added = render({ fileName: 'n.ts', before: '', after: 'x\ny\n', changeType: 'added' })
    const aDv = added.findComponent(DiffViewer)
    assert.equal(aDv.props('changeType'), 'added', 'added 未传 changeType ⇒ 库无法把 before 归空')
    assert.equal(aDv.props('after'), 'x\ny\n', 'added 的 after 未传对')

    const deleted = render({ fileName: 'd.ts', before: 'x\ny\n', after: '', changeType: 'deleted' })
    const dDv = deleted.findComponent(DiffViewer)
    assert.equal(dDv.props('changeType'), 'deleted', 'deleted 未传 changeType ⇒ 库无法把 after 归空')
    assert.equal(dDv.props('before'), 'x\ny\n', 'deleted 的 before 未传对')
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

  it('工作日志侧由 previewMode 控制模式：默认 content，绑定进 FileContentOverlay', () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'packages/client/components/panels/WorklogPane.vue'), 'utf8')
    // [worklog-diff-preview-v1] 变更列表点击：有 patch 切 'diff'，无 patch 退回 'content'（默认）。
    // 只钉 mode="content" 字面量会被 dynamic 绑定合法绕过，断言默认值 + 模板绑定两处。
    assert.match(src, /const previewMode = ref<'diff' \| 'content'>\('content'\)/, 'previewMode 默认值不再钉死 content')
    assert.match(src, /:mode="previewMode"/, '模板未把 previewMode 绑到 mode')
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
