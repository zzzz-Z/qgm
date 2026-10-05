// [multi-script-v1] 守卫：同一条 AI 回复里的后续脚本必须**入队并串行执行**，而不是被守卫静默丢弃。
//
// 背景：`onScriptArrival` 原先只在 waiting/preparing 态接收脚本，其余一律 return。
// 一条回复携带多个脚本时（页面侧现已逐块推送），第 2、3 块到达时首块正在执行 →
// state 已是 parsing/executing → 被丢弃 → 多段执行退化为「只跑第一块」。
// （用户实测表象：应用端改多文件时只改了一部分，其余报错/未生效。）
//
// 本文件守护两件事：
//   ① 队列模块本身的行为（FIFO / 去重 / 计数 / 实例隔离）——纯函数级真跑；
//   ② 接线结构（入队而非 return、轮末必掏、终止即清）——结构断言，防「改了模块没接上」。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {
  clearScripts,
  enqueueScript,
  hasPendingScripts,
  peekPendingScripts,
  pendingScriptCount,
  shiftScript,
} from '../composables/ai/auto-loop/pending-scripts'
import type { InboxItem } from '../composables/runner/useScriptInbox'

const ROOT = process.cwd()
const HANDLERS_SRC = 'packages/client/composables/ai/auto-loop/reply-handlers.ts'
const PANEL_SRC = 'packages/client/components/script/ScriptPanel.vue'

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

/** 造一个最小 InboxItem（只填队列逻辑用得到的字段） */
function item(hash: string, code = `// ${hash}`): InboxItem {
  return { id: `inb_${hash}`, code, lang: 'js', site: 'test', hash, desc: '', why: '', ts: 0 }
}

function reset(): void {
  for (const id of ['L1', 'L2', 'L3']) clearScripts(id)
}

test('queue: 入队后计数与深度同步增长', () => {
  reset()
  assert.equal(pendingScriptCount.value, 0)
  assert.equal(enqueueScript('L1', item('h1')), 1)
  assert.equal(pendingScriptCount.value, 1)
  assert.equal(enqueueScript('L1', item('h2')), 2)
  assert.equal(pendingScriptCount.value, 2)
  assert.ok(hasPendingScripts('L1'))
})

test('queue: 先进先出（与 AI 书写顺序一致）', () => {
  reset()
  enqueueScript('L1', item('h1'))
  enqueueScript('L1', item('h2'))
  enqueueScript('L1', item('h3'))
  assert.equal(shiftScript('L1')?.hash, 'h1')
  assert.equal(shiftScript('L1')?.hash, 'h2')
  assert.equal(shiftScript('L1')?.hash, 'h3')
  assert.equal(shiftScript('L1'), null, '队列空后取队首应返回 null（调用方据此结束本轮批量）')
  assert.equal(pendingScriptCount.value, 0)
})

test('queue: 同 hash 不重复入队（DOM 重排会重推同一块）', () => {
  reset()
  enqueueScript('L1', item('h1'))
  assert.equal(enqueueScript('L1', item('h1')), 1, '重复入队应被忽略，深度保持 1')
  assert.equal(pendingScriptCount.value, 1)
})

test('queue: 多实例互不干扰（按 loopId 隔离）', () => {
  reset()
  enqueueScript('L1', item('h1'))
  enqueueScript('L2', item('h2'))
  assert.equal(pendingScriptCount.value, 2)
  assert.equal(shiftScript('L1')?.hash, 'h1')
  assert.equal(peekPendingScripts('L2').length, 1, 'L1 出队不得影响 L2')
  assert.equal(peekPendingScripts('L1').length, 0)
})

test('queue: clearScripts 归零计数（循环终止/暂停时必须清，否则永久抑制回传）', () => {
  reset()
  enqueueScript('L1', item('h1'))
  enqueueScript('L1', item('h2'))
  clearScripts('L1')
  assert.equal(pendingScriptCount.value, 0)
  assert.ok(!hasPendingScripts('L1'))
  clearScripts('L1')
  assert.equal(pendingScriptCount.value, 0, '重复清空不应把计数压成负数')
})

// ============ 接线结构断言 ============

test('wiring: onScriptArrival 在非等待态必须入队，而不是 return 丢块', () => {
  const src = read(HANDLERS_SRC)
  assert.ok(
    src.includes('enqueueScript(inst.id.value, inboxItem)'),
    'onScriptArrival 未接入 enqueueScript → 同一条回复的第 2、3 个脚本仍会被静默丢弃',
  )
  assert.ok(
    !src.includes('(inst.state.value !== \'waiting\' && inst.state.value !== \'preparing\') return'),
    '恢复成「非等待态一律 return」→ 多段执行失效（本次修复的核心回归点）',
  )
  assert.ok(src.includes('if (st !== \'waiting\' && st !== \'preparing\')'), '应以入队分支替代原先的直接返回')
})

test('wiring: 轮末必须掏队列（try/finally 包裹，防遗漏 return 分支）', () => {
  const src = read(HANDLERS_SRC)
  assert.ok(src.includes('await executeItemInner(inst, inboxItem)'), 'executeItem 应改为包壳，内层业务逻辑下沉到 executeItemInner')
  // [CONSTRAINT] 必须锚定「finally 之后紧跟着 await drainPending(inst)」——
  //   早前这里只写 src.includes('await drainPending(inst)')，被 drainPending 内部自己的递归调用
  //   蒙混通过（变异验证：把 finally 里的调用改成 `void drainPending` 守卫仍全绿），故改成定长邻接匹配。
  assert.ok(
    /async function executeItem\([\s\S]{0,400}?\} finally \{[\s\S]{0,120}?await drainPending\(inst\)/.test(src),
    '掏队列必须在 finally 中且真被 await：内层有 5 个 return 分支（hook 拒绝/停止/无结果/黑名单/脏工作区），逐处补必漏',
  )
})

test('wiring: 循环终止或暂停时必须清空队列', () => {
  const src = read(HANDLERS_SRC)
  assert.ok(
    /function drainPending[\s\S]*?if \(loopPaused\.value \|\| !isInstActive\(inst\)\) \{ clearScripts\(inst\.id\.value\); return \}/.test(src),
    'drainPending 必须在「已暂停 / 已非活动」时清空队列：残留计数会让 pendingScriptCount 长期 > 0，永久抑制结果回传',
  )
})

test('wiring: 队列未清空时 ScriptPanel 不得中途回传结果', () => {
  const src = read(PANEL_SRC)
  assert.ok(src.includes('import { pendingScriptCount }'), 'ScriptPanel 未接入 pendingScriptCount')
  assert.ok(
    src.includes('const midBatch = isLoopActive.value && pendingScriptCount.value > 0'),
    '缺少 midBatch 判据 → 批量脚本执行到一半就把中间结果塞给 AI，与排队块互相踩踏',
  )
  assert.ok(
    src.includes('if (shouldAutoAsk && !midBatch &&'),
    'autoAsk 分支未被 midBatch 拦住 → 中途回传仍会发生',
  )
})
