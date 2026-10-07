// @vitest-environment happy-dom
// [task-progress-panel-e2e-v1] 组件级 e2e：验证面板在 todo/done 数据下的渲染与隐藏
// [taskboard-sid-guard-v1] 须 mock activeSessionId：真实 useAppStorage 读 localStorage，
//   测试间残留 sid 会让「面板渲染」用例在干净环境假红 / 脏环境假绿（顺序依赖）
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import TaskProgressPanel from '../components/script/TaskProgressPanel.vue'

// [taskboard-loop-badge-v1] kindRef 形状对齐真实 RuntimeState：state.value 是 { kind, ... } 对象（非裸字符串）
const { sidRef, kindRef } = vi.hoisted(() => ({ sidRef: { value: 'test-sid' }, kindRef: { value: { kind: 'idle' } } }))
vi.mock('../composables/ui/useAppStorage', () => ({ activeSessionId: sidRef, effectiveSessionId: sidRef }))
// [taskboard-loop-badge-v1] mock 循环状态单一真相源：真实 useRuntime 会碰 transport，且测试需可控 kind
vi.mock('../composables/ai/useRuntime', () => ({
  useRuntime: () => ({ state: kindRef }),
}))

const originalFetch = globalThis.fetch

function mockTasks(payload: unknown, ok = true) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok,
    json: async () => payload,
  }) as unknown as typeof fetch
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
})

afterEach(() => {
  vi.useRealTimers()
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

test('有 todo + done：面板渲染、待办在前、已完成划线', async () => {
  mockTasks({ todo: ['任务A', '任务B'], done: [{ item: '任务X', at: 1, round: 1 }] })
  const w = mount(TaskProgressPanel)
  await flushPromises()
  expect(w.find('.task-progress').exists()).toBe(true)
  expect(w.find('.tp-count').text()).toBe('1/3')
  const items = w.findAll('.tp-item')
  expect(items.length).toBe(3)
  expect(items[0].classes()).not.toContain('done')
  expect(items[1].classes()).not.toContain('done')
  expect(items[2].classes()).toContain('done')
  expect(items[2].text()).toContain('任务X')
  w.unmount()
})

test('todo/done 皆空：面板常驻显示空态文案', async () => {
  mockTasks({ todo: [], done: [] })
  const w = mount(TaskProgressPanel)
  await flushPromises()
  expect(w.find('.task-progress').exists()).toBe(true)
  expect(w.find('.tp-empty').exists()).toBe(true)
  expect(w.find('.tp-empty').text()).toContain('暂无任务')
  w.unmount()
})
test('过滤空串：todo 含空条目不应计入', async () => {
  mockTasks({ todo: ['', '   ', '有效任务'], done: [] })
  const w = mount(TaskProgressPanel)
  await flushPromises()
  expect(w.find('.tp-count').text()).toBe('0/1')
  w.unmount()
})

test('fetch 失败：不崩溃、面板空态', async () => {
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }) as unknown as typeof fetch
  const w = mount(TaskProgressPanel)
  await flushPromises()
  expect(w.find('.task-progress').exists()).toBe(true)
  expect(w.find('.tp-empty').exists()).toBe(true)
  w.unmount()
})

test('折叠按钮点击切换 collapsed 类', async () => {
  mockTasks({ todo: ['T'], done: [] })
  const w = mount(TaskProgressPanel)
  await flushPromises()
  expect(w.find('.task-progress').classes()).not.toContain('collapsed')
  await w.find('.tp-head').trigger('click')
  expect(w.find('.task-progress').classes()).toContain('collapsed')
  w.unmount()
})

// ---------- [task-board-items-v1] 结构化任务（items）渲染 ----------

test('items: 四态渲染（执行中 / 待办 / 失败 / 已完成），失败项带 failed 类与 ✗', async () => {
  mockTasks({
    items: [
      { id: 'r', desc: '在跑的任务', status: 'running' },
      { id: 'p', desc: '待办任务', status: 'pending' },
      { id: 'f', desc: '失败的任务', status: 'failed', failedAt: 1700000000000 },
      { id: 'd', desc: '完成的任务', status: 'done', doneAt: 1700000000000 },
    ],
    todo: ['在跑的任务', '待办任务', '失败的任务'],
    done: [{ item: '完成的任务', at: 1700000000000 }],
    running: '在跑的任务',
  })
  const w = mount(TaskProgressPanel)
  await flushPromises()
  // 计数只算 done（1/4），失败不计入完成
  expect(w.find('.tp-count').text()).toBe('1/4')
  const failed = w.find('.tp-item.failed')
  expect(failed.exists()).toBe(true)
  expect(failed.text()).toContain('失败的任务')
  expect(failed.find('.tp-icon').text()).toBe('✗')
  expect(w.find('.tp-item.running').text()).toContain('在跑的任务')
  // 分组顺序：失败段在已完成段之前
  const labels = w.findAll('.tp-group-label').map(n => n.text())
  expect(labels.indexOf('失败')).toBeLessThan(labels.indexOf('已完成'))
  w.unmount()
})

test('items: running 项被服务端判过期后（status=pending）不再显示为执行中', async () => {
  mockTasks({
    items: [
      { id: 'a', desc: '过期的任务', status: 'pending' },
      { id: 'b', desc: '新任务', status: 'pending' },
    ],
    todo: ['过期的任务', '新任务'],
    done: [],
    running: '',
    expiredRunning: ['过期的任务'],
  })
  const w = mount(TaskProgressPanel)
  await flushPromises()
  expect(w.find('.tp-item.running').exists()).toBe(false)
  expect(w.findAll('.tp-item').length).toBe(2)
  w.unmount()
})

// ---------- [taskboard-stale-v1] 陈旧提示 ----------

test('stale: 有数据后连续 3 次拉取失败 → 提示数据可能过期', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  mockTasks({ todo: ['任务A'], done: [] })
  const w = mount(TaskProgressPanel)
  await flushPromises()
  expect(w.find('.tp-stale').exists()).toBe(false)
  // 之后连续 3 次失败（模拟服务挂掉）
  globalThis.fetch = vi.fn().mockRejectedValue(new Error('net-down')) as unknown as typeof fetch
  for (let i = 0; i < 3; i++) {
    await vi.advanceTimersByTimeAsync(2000)
    await flushPromises()
  }
  expect(w.find('.tp-stale').exists()).toBe(true)
  expect(w.find('.tp-stale').text()).toContain('可能已过期')
  // 恢复成功 → 提示消失（单次抖动不误报，恢复即清零）
  mockTasks({ todo: ['任务A'], done: [] })
  await vi.advanceTimersByTimeAsync(2000)
  await flushPromises()
  expect(w.find('.tp-stale').exists()).toBe(false)
  w.unmount()
})

test('stale: 从来没有数据时失败不提示（空态优先，避免重复表达）', async () => {
  globalThis.fetch = vi.fn().mockRejectedValue(new Error('net-down')) as unknown as typeof fetch
  const w = mount(TaskProgressPanel)
  await flushPromises()
  expect(w.find('.tp-empty').exists()).toBe(true)
  expect(w.find('.tp-stale').exists()).toBe(false)
  w.unmount()
})

// ---------- [taskboard-clear-v1] / [taskboard-retry-v1] / [taskboard-failed-badge-v1] 手动操作 ----------

/** 有状态 mock：GET 在 POST 前返回 initial、POST 后返回 afterPost；记录全部 POST body */
function mockBoard(initial: unknown, afterPost: unknown) {
  const posts: Array<Record<string, unknown>> = []
  let posted = false
  globalThis.fetch = vi.fn().mockImplementation(async (input: unknown, init?: { method?: string, body?: string }) => {
    if (init?.method === 'POST' && typeof init.body === 'string') {
      try { posts.push(JSON.parse(init.body) as Record<string, unknown>) } catch { /* ignore */ }
      posted = true
    }
    return { ok: true, json: async () => (posted ? afterPost : initial) } as Response
  }) as unknown as typeof fetch
  return posts
}

test('clear: 全部完成无待办 → 头部出现清空按钮，点击发 set 空清单（带 sid）', async () => {
  const posts = mockBoard(
    { items: [{ id: 'd', desc: '完成的任务', status: 'done', doneAt: 1 }] },
    { items: [] },
  )
  const w = mount(TaskProgressPanel)
  await flushPromises()
  const btn = w.find('.tp-clear')
  expect(btn.exists()).toBe(true)
  await btn.trigger('click')
  await flushPromises()
  expect(posts.length).toBe(1)
  expect(posts[0].mode).toBe('set')
  expect(posts[0].sid).toBe('test-sid')
  expect(posts[0].todo).toEqual([])
  // 清空后面板回空态（服务端删桶 → GET 回空）
  expect(w.find('.tp-empty').exists()).toBe(true)
  w.unmount()
})

// [leftover-clear-fix-v1] 原判据「有待办就不显示清空」与 leftover 提示互斥：
//   提示叫用户「点上方清空」，但按钮恰好要求无待办 ⇒ 永远不渲染（死引导）。
//   新语义：只要有「执行中」项就不显示（防误删进行中的清单）；待办而无执行中 = 循环未跑，可清。
test('clear: 遗留待办（无执行中）→ 显示清空按钮，点击发 set 空清单', async () => {
  const posts = mockBoard(
    { items: [{ id: 'p', desc: '待办任务', status: 'pending' }, { id: 'd', desc: '完成的任务', status: 'done' }] },
    { items: [] },
  )
  const w = mount(TaskProgressPanel)
  await flushPromises()
  const btn = w.find('.tp-clear')
  expect(btn.exists()).toBe(true)
  await btn.trigger('click')
  await flushPromises()
  expect(posts.length).toBe(1)
  expect(posts[0].mode).toBe('set')
  expect(posts[0].sid).toBe('test-sid')
  expect(posts[0].todo).toEqual([])
  w.unmount()
})

test('clear: 有执行中任务时不显示清空按钮（防误删进行中的清单）', async () => {
  mockTasks({ items: [{ id: 'r', desc: '执行中任务', status: 'running' }, { id: 'p', desc: '待办任务', status: 'pending' }] })
  const w = mount(TaskProgressPanel)
  await flushPromises()
  expect(w.find('.tp-clear').exists()).toBe(false)
  w.unmount()
})

// ---------- [taskboard-loop-badge-v1] 循环运行状态徽章 ----------

test('loopBadge: 头部显示循环状态徽章，文案随 kind 变化', async () => {
  mockTasks({ items: [{ id: 'a', desc: '任务A', status: 'pending' }] })
  kindRef.value = { kind: 'running' }
  let w = mount(TaskProgressPanel)
  await flushPromises()
  expect(w.find('.tp-loop').text()).toBe('运行中')
  expect(w.find('.tp-loop').classes()).toContain('loop-running')
  w.unmount()

  kindRef.value = { kind: 'idle' }
  w = mount(TaskProgressPanel)
  await flushPromises()
  expect(w.find('.tp-loop').text()).toBe('未运行')
  expect(w.find('.tp-loop').classes()).toContain('loop-stopped')
  w.unmount()
})

// [loop-badge-coverage-v1] 承重判据：LoopState 13 态若有任一缺映射，就会回落 idle「未运行」——
//   最刺眼的是 executing（脚本真的在跑）也显示「未运行」。
test('loopBadge: 13 个 LoopState 各有专属文案，非 idle 态不得回落「未运行」', async () => {
  mockTasks({ items: [{ id: 'a', desc: '任务A', status: 'pending' }] })
  const kinds = ['running', 'preparing', 'parsing', 'executing', 'feedback', 'waiting', 'waiting-input', 'handoff', 'paused', 'budget-limited', 'stopped', 'interrupted', 'idle']
  const seen = new Set<string>()
  for (const k of kinds) {
    kindRef.value = { kind: k }
    const w = mount(TaskProgressPanel)
    await flushPromises()
    const text = w.find('.tp-loop').text()
    expect(text, `kind=${k} 缺映射 ⇒ 回落「未运行」`).not.toBe('')
    if (k !== 'idle') expect(text, `kind=${k} 不得回落 idle 文案`).not.toBe('未运行')
    seen.add(text)
    w.unmount()
  }
  expect(seen.size, `文案重复，状态之间无法区分：${[...seen].join(' / ')}`).toBe(kinds.length)
  kindRef.value = { kind: 'idle' }
})

test('loopBadge: leftover 提示按循环状态分叉文案', async () => {
  mockTasks({ items: [{ id: 'p', desc: '待办任务', status: 'pending' }] })
  kindRef.value = { kind: 'idle' }
  let w = mount(TaskProgressPanel)
  await flushPromises()
  expect(w.find('.tp-leftover').exists()).toBe(true)
  expect(w.find('.tp-leftover').text()).toContain('循环未运行')
  w.unmount()

  kindRef.value = { kind: 'running' }
  w = mount(TaskProgressPanel)
  await flushPromises()
  expect(w.find('.tp-leftover').text()).toContain('循环运行中')
  w.unmount()
  kindRef.value = { kind: 'idle' }
})

test('retry: 失败行有重试按钮，点击发 push 重新登记原文，行回待办态', async () => {
  const posts = mockBoard(
    { items: [{ id: 'f', desc: '失败的任务', status: 'failed', failedAt: 1 }] },
    { items: [{ id: 'f', desc: '失败的任务', status: 'pending' }] },
  )
  const w = mount(TaskProgressPanel)
  await flushPromises()
  expect(w.find('.tp-item.failed').exists()).toBe(true)
  await w.find('.tp-retry').trigger('click')
  await flushPromises()
  expect(posts.length).toBe(1)
  expect(posts[0].mode).toBe('push')
  expect(posts[0].sid).toBe('test-sid')
  expect(posts[0].pushTodo).toEqual(['失败的任务'])
  // 重新登记后行不再是 failed 态
  expect(w.find('.tp-item.failed').exists()).toBe(false)
  w.unmount()
})

// [taskboard-hide-when-empty-v1] 无任务时隐藏看板（v-show，非 v-if，保留轮询）
test('空态：无任务时 .task-progress 不可见但组件仍挂载', async () => {
  mockTasks({ items: [] })
  const w = mount(TaskProgressPanel)
  await flushPromises()
  const el = w.find('.task-progress')
  expect(el.exists()).toBe(true)
  expect(el.attributes('style')).toContain('display: none')
  w.unmount()
})

test('空态→有任务：轮询后从隐藏切为可见', async () => {
  mockTasks({ items: [] })
  const w = mount(TaskProgressPanel)
  await flushPromises()
  expect(w.find('.task-progress').attributes('style')).toContain('display: none')
  mockTasks({ items: [{ id: 'a', desc: '新任务', status: 'pending' }] })
  await vi.advanceTimersByTimeAsync(2000)
  await flushPromises()
  const el = w.find('.task-progress')
  expect(el.attributes('style') || '').not.toContain('display: none')
  w.unmount()
})

test('failedBadge: 有失败项时头部显示失败计数徽章', async () => {
  mockTasks({ items: [
    { id: 'f', desc: '失败的任务', status: 'failed', failedAt: 1 },
    { id: 'g', desc: '另一个失败的', status: 'failed', failedAt: 2 },
    { id: 'd', desc: '完成的任务', status: 'done', doneAt: 3 },
  ] })
  const w = mount(TaskProgressPanel)
  await flushPromises()
  const badge = w.find('.tp-failed-badge')
  expect(badge.exists()).toBe(true)
  expect(badge.text()).toBe('2 失败')
  w.unmount()
})
