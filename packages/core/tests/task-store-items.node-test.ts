// [task-board-items-guard-v1] 工单 WO-20261005-taskboard 守卫：结构化任务 / 三级匹配 / 超时回收 / 旧格式升格 / CAS
// [承重要求] 每条判据对应一处可变异点：把被测条件改恒真（或把修复回退）后，本条必须变红
import { afterEach, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  applyTaskMutation,
  bucketItems,
  commitTaskState,
  gcStaleBuckets,
  matchItems,
  MAX_TERMINAL_ITEMS,
  mutateTaskState,
  normKey,
  readTaskState,
  RUNNING_TIMEOUT_MS,
  STALE_BUCKET_MS,
  taskId,
} from '../src/state/task-store.js'
import type { TaskItem, TaskState } from '../src/state/task-store.js'
import { getRoot, setRoot } from '../src/config.js'

// [测试根隔离] getRoot() 是模块级缓存（env 不生效），必须走 setRoot 才能真正重定向工作区，
//   否则测试会写进真实 .ai-runner/state.json（实测过一次，见 2026-10-05 记忆）
const ORIG_ROOT = getRoot()
afterEach(() => {
  setRoot(ORIG_ROOT)
})

function makeState(over: Partial<TaskState> = {}): TaskState {
  return { round: 1, status: 'running', todo: [], done: [], ...over }
}

function item(desc: string, status: TaskItem['status'] = 'pending', over: Partial<TaskItem> = {}): TaskItem {
  return { id: taskId(desc), desc, status, createdAt: 1, ...over }
}

/** 建临时工作区并写 state.json（避免污染真实 .ai-runner） */
function withTempRoot(state: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskboard-'))
  fs.mkdirSync(path.join(dir, '.ai-runner'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.ai-runner', 'state.json'), JSON.stringify(state, null, 2))
  setRoot(dir)
  return dir
}

// ---------- G1 三级匹配：id / 归一化漂移 / 唯一子串 ----------

test('G1: complete 按 id 命中并移除该项', () => {
  const cur = makeState({ items: [item('跑全量测试'), item('写工单')] })
  const next = applyTaskMutation(cur, { mode: 'complete', complete: [taskId('写工单')] })
  assert.equal(next.done.length, 0)
  assert.ok(!(next.items || []).some(i => i.desc === '写工单'), '命中项已移除')
  assert.ok((next.items || []).some(i => i.desc === '跑全量测试'), '未命中项保留')
})

test('G1: complete 措辞漂移仍命中并移除', () => {
  const cur = makeState({ items: [item('修复看板：running 超时')] })
  const next = applyTaskMutation(cur, { mode: 'complete', complete: ['修复看板:  running 超时'] })
  assert.equal(next.done.length, 0)
  assert.equal((next.items || []).length, 0, '归一化命中即移除')
})

test('G1: complete 唯一子串包含命中并移除', () => {
  const cur = makeState({ items: [item('补未完成部分'), item('整理文档')] })
  const next = applyTaskMutation(cur, { mode: 'complete', complete: ['只补未完成部分'] })
  assert.equal(next.done.length, 0)
  assert.ok(!(next.items || []).some(i => i.desc === '补未完成部分'))
  assert.ok((next.items || []).some(i => i.desc === '整理文档'))
})

test('G1: 无命中 → 状态不动且告警（不静默失败）', () => {
  const cur = makeState({ items: [item('甲'), item('乙')] })
  const next = applyTaskMutation(cur, { mode: 'complete', complete: ['完全不相干的任务描述'] })
  assert.equal(next.done.length, 0)
  assert.equal(next.todo.length, 2)
  assert.ok((next.warnings || []).some(w => w.includes('未命中')), `应带未命中告警: ${JSON.stringify(next.warnings)}`)
})

test('G1: 子串兜底要求唯一命中（两条候选 → 不猜）', () => {
  const cur = makeState({ items: [item('修复看板超时'), item('修复看板串台')] })
  const next = applyTaskMutation(cur, { mode: 'complete', complete: ['修复看板'] })
  assert.equal(next.done.length, 0, '多候选时禁止命中，避免误标完成')
})

// ---------- G2 normKey 全文（不再截断 80 字符） ----------

test('G2: 前 80 字符相同的两条长任务不互撞（push 各自入列）', () => {
  const head = '重构任务看板服务端存储层结构'.repeat(6) // > 80 字符公共前缀
  const a = `${head}甲分支`
  const b = `${head}乙分支`
  assert.equal(normKey(a).length, normKey(b).length)
  assert.notEqual(normKey(a), normKey(b), 'normKey 必须区分长后缀（旧实现截断 80 字符后相等）')
  const cur = makeState({ items: [] })
  const next = applyTaskMutation(cur, { mode: 'push', pushTodo: [a, b] })
  assert.equal(next.items?.length, 2, '两条不同任务都必须入列，不得静默丢弃')
})

test('G2: push 去重仍生效（同文本不重复登记）', () => {
  const cur = makeState({ items: [item('去重项')] })
  const next = applyTaskMutation(cur, { mode: 'push', pushTodo: ['去重项', ' 去重项 '] })
  assert.equal(next.items?.length, 1)
})

// ---------- G3 running 超时回收 ----------

test('G3: running 超过阈值 → 投影回退 pending 且进入 expiredRunning', () => {
  const stale = Date.now() - RUNNING_TIMEOUT_MS - 60_000
  const cur = makeState({ items: [item('卡住的任务', 'running', { startedAt: stale })] })
  const next = applyTaskMutation(cur, { mode: 'push', pushTodo: ['新任务'] })
  assert.equal(next.running, '', '过期 running 不再算执行中')
  assert.deepEqual(next.expiredRunning, ['卡住的任务'])
  assert.ok(next.todo.includes('卡住的任务'), '过期项回到待办，不丢')
  assert.equal(next.items?.find(i => i.desc === '卡住的任务')?.status, 'pending', '写入路径应自愈落盘为 pending')
})

test('G3: running 未超阈值不动（防误杀）', () => {
  const fresh = Date.now() - 60_000
  const cur = makeState({ items: [item('在跑的任务', 'running', { startedAt: fresh })] })
  const next = applyTaskMutation(cur, { mode: 'push', pushTodo: ['新任务'] })
  assert.equal(next.running, '在跑的任务')
  assert.equal(next.expiredRunning, undefined)
})

test('G3: startedAt=0（旧数据时刻未知）不过期', () => {
  const cur = makeState({ items: [item('旧运行项', 'running', { startedAt: 0 })] })
  const next = applyTaskMutation(cur, { mode: 'push', pushTodo: ['新任务'] })
  assert.equal(next.running, '旧运行项', '时刻未知不得判过期')
})

test('G3: start 切项时旧 running 显式回退 pending（不再无声消失）', () => {
  const cur = makeState({ items: [item('甲', 'running', { startedAt: Date.now() - 1000 }), item('乙')] })
  const next = applyTaskMutation(cur, { mode: 'start', start: ['乙'] })
  assert.equal(next.running, '乙')
  const a = next.items?.find(i => i.desc === '甲')
  assert.equal(a?.status, 'pending', '旧 running 必须留下可见痕迹')
})

// ---------- G4 fail 态 ----------

test('G4: fail 命中 → failed 且带 failedAt，不计入 done', () => {
  const cur = makeState({ items: [item('坏掉的任务', 'running', { startedAt: Date.now() })] })
  const next = applyTaskMutation(cur, { mode: 'fail', fail: ['坏掉的任务'] })
  const it = next.items?.find(i => i.desc === '坏掉的任务')
  assert.equal(it?.status, 'failed')
  assert.ok(Number(it?.failedAt) > 0)
  assert.equal(next.done.length, 0)
  assert.equal(next.running, '')
})

test('G4: fail 未命中 → 告警且原状态不变', () => {
  const cur = makeState({ items: [item('甲')] })
  const next = applyTaskMutation(cur, { mode: 'fail', fail: ['不存在项'] })
  assert.equal(next.items?.[0].status, 'pending')
  assert.ok((next.warnings || []).length > 0)
})

// [failed-separated-v1] P0-1b 承重判据：fail 只标状态不移除（task-store:616），
//   若 projectItems 不把 failed 从 todo 排除，则该失败项会永久留在 todo ⇒
//   DONE 触发「无遗留 @todo」永不成立（§1D 环式死锁第五条链路）。
test('G4b: fail 后该项不计入 todo，单独进 failed 组', () => {
  const cur = makeState({ items: [item('坏掉的任务', 'running', { startedAt: Date.now() }), item('好的任务')] })
  const next = applyTaskMutation(cur, { mode: 'fail', fail: ['坏掉的任务'] })
  assert.ok(!next.todo.includes('坏掉的任务'), 'failed 项不得留在 todo（否则 DONE 无出口）')
  assert.ok((next.failed || []).includes('坏掉的任务'), 'failed 项须单独成组')
  assert.ok(next.todo.includes('好的任务'), 'pending 项仍在 todo')
})

// ---------- G5 deps 告警 ----------

test('G5: 依赖未完成 → complete 仍然移除但带 deps 告警', () => {
  const a = item('前置任务')
  const b = item('后续任务', 'pending', { deps: [taskId('前置任务')] })
  const cur = makeState({ items: [a, b] })
  const next = applyTaskMutation(cur, { mode: 'complete', complete: ['后续任务'] })
  assert.equal(next.done.length, 0)
  assert.ok(!(next.items || []).some(i => i.desc === '后续任务'), '不阻断移除')
  assert.ok((next.warnings || []).some(w => w.includes('deps 未完成')), `应告警: ${JSON.stringify(next.warnings)}`)
})

// ---------- G6 CAS 提交 ----------

test('G6: version 前置条件不符 → 拒写且磁盘不变', () => {
  const dir = withTempRoot({ version: 7, tasksBySid: {} })
  const before = fs.readFileSync(path.join(dir, '.ai-runner', 'state.json'), 'utf8')
  const res = commitTaskState(makeState({ items: [item('不应落盘')] }), 'sid-x', 6)
  assert.equal(res.ok, false)
  assert.equal(res.version, 7)
  assert.equal(fs.readFileSync(path.join(dir, '.ai-runner', 'state.json'), 'utf8'), before, '拒写时磁盘必须原样')
})

test('G6: version 相符 → 落盘且 version 自增', () => {
  const dir = withTempRoot({ version: 3, tasksBySid: {} })
  const res = commitTaskState(makeState({ items: [item('应落盘')] }), 'sid-x', 3)
  assert.equal(res.ok, true)
  const disk = JSON.parse(fs.readFileSync(path.join(dir, '.ai-runner', 'state.json'), 'utf8'))
  assert.equal(disk.version, 4)
  assert.equal(disk.tasksBySid['sid-x'].items[0].desc, '应落盘')
})

test('G6: 冲突拒写后重放收敛——外部写入与本次变更都不丢', () => {
  const dir = withTempRoot({ version: 1, tasksBySid: { 'sid-a': { items: [item('原有项')] } } })
  // ① 持陈旧版本提交：必须被拒（模拟另一进程抢先写入后本进程仍持旧版本）
  const stale = commitTaskState(makeState({ items: [item('原有项'), item('我的新项')] }), 'sid-a', 0)
  assert.equal(stale.ok, false, '陈旧版本提交必须被拒')
  // ② 模拟另一进程写入（版本 +1、桶里多一项）
  fs.writeFileSync(path.join(dir, '.ai-runner', 'state.json'), JSON.stringify({
    version: 2,
    tasksBySid: { 'sid-a': { items: [item('原有项'), item('他人写项')] } },
  }, null, 2))
  // ③ 重放（mutateTaskState 内部即「重读版本 → 重放变更 → 再提交」）：两边都不丢
  const out = mutateTaskState('sid-a', { mode: 'push', pushTodo: ['我的新项'] })
  assert.equal(out.degraded, false)
  assert.deepEqual((out.state.items || []).map(i => i.desc), ['原有项', '他人写项', '我的新项'], '外部写项与本次变更都必须保留')
  assert.equal(out.attempts, 1, '无竞争时一次成功')
})

// ---------- G7 旧格式升格 ----------

test('G7: 旧格式桶（todo/done/running 字符串）升格为 items，完成时刻不丢', () => {
  const items = bucketItems({
    todo: ['待办甲', '待办乙'],
    done: [{ item: '已完成丙', at: 1712345678901, round: 9 }],
    running: '待办甲',
  })
  assert.equal(items.length, 3)
  const doneItem = items.find(i => i.desc === '已完成丙')
  assert.equal(doneItem?.status, 'done')
  assert.equal(doneItem?.doneAt, 1712345678901, '旧 at 必须保留')
  assert.equal(doneItem?.round, 9)
  const runItem = items.find(i => i.desc === '待办甲')
  assert.equal(runItem?.status, 'running')
  assert.equal(runItem?.startedAt, 0, '旧数据时刻未知记 0（不伪造当前时间）')
})

test('G7: 旧格式 running 不在 todo 里也要保留（旧面板单独一行的语义）', () => {
  const items = bucketItems({ todo: ['甲'], done: [], running: '游离运行项' })
  assert.ok(items.some(i => i.desc === '游离运行项' && i.status === 'running'))
})

test('G7: readTaskState 对真实旧格式 state.json 端到端升格', () => {
  const dir = withTempRoot({
    version: 11,
    tasksBySid: { 'sid-old': { todo: ['旧待办'], done: [{ item: '旧完成', at: 99 }], running: '旧待办' } },
  })
  void dir
  const st = readTaskState('sid-old')
  assert.equal(st.running, '旧待办')
  assert.ok((st.items || []).some(i => i.desc === '旧完成' && i.status === 'done'))
  assert.equal(st.done.find(d => d.item === '旧完成')?.at, 99)
})

test('G7: 桶写空 → 删桶（防 state.json 无界增长）', () => {
  const dir = withTempRoot({ version: 5, tasksBySid: { 'sid-clean': { items: [item('待清空')] } } })
  void dir
  const res = commitTaskState(makeState({ items: [] }), 'sid-clean', 5)
  assert.equal(res.ok, true)
  const disk = JSON.parse(fs.readFileSync(path.join(dir, '.ai-runner', 'state.json'), 'utf8'))
  assert.equal(Object.keys(disk.tasksBySid).length, 0, '清空后桶必须删除')
})

// ---------- 回归：单 running 与 matchItems 边界 ----------

test('回归: matchItems 空键与短键不误配', () => {
  const items = [item('T1'), item('T2')]
  assert.equal(matchItems(items, ['']).hit.length, 0)
  assert.equal(matchItems(items, ['T']).hit.length, 0, '短键（<3）不启用子串兜底')
  assert.equal(matchItems(items, ['T1']).hit.length, 1, '归一化精确仍可命中短键')
})

test('G1b: 中文短键（3 字）唯一候选时子串命中并移除', () => {
  const cur = makeState({ items: [item('跑全量测试'), item('写工单')] })
  const next = applyTaskMutation(cur, { mode: 'complete', complete: ['跑全量'] })
  assert.equal(next.done.length, 0)
  assert.ok(!(next.items || []).some(i => i.desc === '跑全量测试'), '「跑全量」唯一命中并移除')
  assert.ok((next.items || []).some(i => i.desc === '写工单'))
})

// [task-batch-clear-v3] 守卫：新 push 保留历史终结项（不再全清），活动项永不淘汰
test('task-batch-clear-v3: 新 push 保留旧批 done（不再消失）', () => {
  const cur = makeState({ items: [item('旧A', 'done', { doneAt: 1 }), item('旧B', 'done', { doneAt: 2 })] })
  const next = applyTaskMutation(cur, { mode: 'push', pushTodo: ['新任务'] })
  assert.deepEqual((next.items || []).map(i => i.desc).sort(), ['新任务', '旧A', '旧B'].sort(), '旧 done 必须保留')
  assert.equal(next.done.length, 2)
})

test('task-batch-clear-v3: 保留 pending 与 done 混合', () => {
  const cur = makeState({ items: [item('旧A', 'done', { doneAt: 1 }), item('旧B', 'pending')] })
  const next = applyTaskMutation(cur, { mode: 'push', pushTodo: ['新任务'] })
  assert.deepEqual((next.items || []).map(i => i.desc).sort(), ['新任务', '旧A', '旧B'].sort())
})

test('task-batch-clear-v3: 终结项超上限时淘汰最旧（活动项不淘汰）', () => {
  const many = Array.from({ length: MAX_TERMINAL_ITEMS + 5 }, (_, i) => item(`终${i}`, 'done', { doneAt: i + 1 }))
  const cur = makeState({ items: [...many, item('活动')] })
  const next = applyTaskMutation(cur, { mode: 'push', pushTodo: ['新任务'] })
  const descs = (next.items || []).map(i => i.desc)
  assert.equal(descs.filter(d => d.startsWith('终')).length, MAX_TERMINAL_ITEMS, '终结项保留上限')
  assert.ok(descs.includes('活动'), '活动项永不淘汰')
  assert.ok(!descs.includes('终0'), '最旧的终结项被淘汰')
})
test('回归: applyTaskMutation 无 items 时从 todo/done 自举（旧调用方兼容）', () => {
  const cur = makeState({ todo: ['A', 'B'], done: [{ item: 'Z', at: 1, round: 1 }], running: 'A' })
  const next = applyTaskMutation(cur, { mode: 'complete', complete: ['A'] })
  assert.deepEqual(next.todo, ['B'])
  assert.equal(next.running, '')
  // [task-complete-remove-v1] complete 改为移除命中项：A 被移除，Z（既有 done）保留
  assert.deepEqual(next.done.map(d => d.item), ['Z'])
})
// [session-single-source-v1] 写端 sessionId: sid || getSessionId() 的守卫：
//   回退到无条件 getSessionId() 时，state.sessionId 变随机值，本组必红。
test('P0-1: state.sessionId 与 tasksBySid keys 一致（单 sid）', () => {
  const dir = withTempRoot({ round: 0, status: 'idle' })
  commitTaskState(makeState({ items: [item('A')] }), 'sid-a')
  const disk = JSON.parse(fs.readFileSync(path.join(dir, '.ai-runner', 'state.json'), 'utf8'))
  const st = readTaskState()
  assert.equal(st.sessionId, 'sid-a', 'sessionId 应为真 sid 而非随机生成')
  assert.ok(Object.keys(disk.tasksBySid).includes('sid-a'), 'sid-a 应在 tasksBySid')
  assert.ok(Object.keys(disk.tasksBySid).includes(st.sessionId), 'sessionId 必须 ∈ tasksBySid keys')
})

test('P0-1: 多 sid 时 sessionId 等于最后写入的 sid', () => {
  withTempRoot({ round: 0, status: 'idle' })
  commitTaskState(makeState({ items: [item('A')] }), 'sid-a')
  commitTaskState(makeState({ items: [item('B')] }), 'sid-b')
  const st = readTaskState()
  assert.equal(st.sessionId, 'sid-b', '多会话共存时 sessionId 取最近活跃')
})

// [task-bucket-gc-v1] 桶 GC 守卫
test('GC: updatedAt 超期 → 桶被清', () => {
  const now = Date.now()
  const { kept, dropped } = gcStaleBuckets({ 'old-sid': { items: [], updatedAt: now - STALE_BUCKET_MS - 1000 } }, now)
  assert.deepEqual(dropped, ['old-sid'])
  assert.deepEqual(Object.keys(kept), [])
})

test('GC: updatedAt 未超期 → 桶保留', () => {
  const now = Date.now()
  const { kept, dropped } = gcStaleBuckets({ 'active-sid': { items: [], updatedAt: now - 1000 } }, now)
  assert.deepEqual(dropped, [])
  assert.deepEqual(Object.keys(kept), ['active-sid'])
})

test('GC: 无 updatedAt（老桶）→ 保留，防误删', () => {
  const now = Date.now()
  const { kept, dropped } = gcStaleBuckets({ 'legacy-sid': { items: [] } }, now)
  assert.deepEqual(dropped, [])
  assert.deepEqual(Object.keys(kept), ['legacy-sid'])
})

// [taskboard-stale-running-heal-v1] 「状态一直不变」根因守卫：
//   面板 view 优先消费 items；若 readTaskState 返回未愈合的 items，
//   超过 RUNNING_TIMEOUT_MS 的 running 项会永久显示「执行中」。
//   承重：把 healed 改回 merged ⇒ 本条变红。
test('读路径愈合：过期 running 在 items 里回退为 pending', () => {
  const stale = Date.now() - RUNNING_TIMEOUT_MS - 60_000
  withTempRoot({
    round: 1,
    status: 'running',
    version: 1,
    tasksBySid: {
      s1: {
        items: [
          { id: taskId('久挂任务'), desc: '久挂任务', status: 'running', createdAt: 1, startedAt: stale },
        ],
        updatedAt: Date.now(),
      },
    },
  })
  const st = readTaskState('s1')
  const it = (st.items || []).find(x => x.desc === '久挂任务')
  assert.ok(it, '找不到该 item')
  assert.equal(it!.status, 'pending', '过期 running 未在 items 里愈合为 pending（面板会永显执行中）')
  assert.equal(it!.startedAt, undefined, '愈合后应清 startedAt')
})

test('读路径愈合：未过期的 running 保持不变', () => {
  const fresh = Date.now() - 1000
  withTempRoot({
    round: 1,
    status: 'running',
    version: 1,
    tasksBySid: {
      s1: {
        items: [
          { id: taskId('进行中'), desc: '进行中', status: 'running', createdAt: 1, startedAt: fresh },
        ],
        updatedAt: Date.now(),
      },
    },
  })
  const st = readTaskState('s1')
  const it = (st.items || []).find(x => x.desc === '进行中')
  assert.equal(it!.status, 'running', '未过期的 running 不应被回退')
})
