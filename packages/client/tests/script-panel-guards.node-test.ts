// [script-panel-guards-v1] ScriptPanel 的结构守卫（从 multiScriptQueue 迁出）。
// [WHY] multiScriptQueue 主体测 auto-loop/pending-scripts（随 P3b 删除），
//   但其中两条用例守的是留存路径（isLoopActive 已摘 / statusText 渲染完整），须保留。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()
const PANEL_SRC = 'packages/client/components/script/ScriptPanel.vue'

/**
 * [p2-strip-v1] 剥 HTML/CSS/JS 注释后再判「是否仍含某词」——
 *  摘除说明注释里会保留被摘符号名，不剥会假红。
 */
function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}
function read(rel: string): string { return fs.readFileSync(path.join(ROOT, rel), 'utf8') }

test('[P2] ScriptPanel 已摘除 isLoopActive 守卫：单路径下无双发风险', () => {
  const src = read(PANEL_SRC)
  // [loop-consolidation-P2] 原守卫防「循环引擎 + ScriptPanel 同轮双发」；循环引擎已退役，
  //   回传权唯一归 ScriptPanel（留存路径）。
  // [VARIANT] 若把 !isLoopActive.value 加回 shouldAutoAsk 条件 ⇒ 本条应变红。
  assert.ok(
    !stripComments(src).includes('isLoopActive'),
    'isLoopActive 应已随 P2 从 ScriptPanel 摘除',
  )
})

// ============ 执行状态条接线（status-bar-v1）============

test('wiring: ScriptPanel 必须渲染 statusText 族（防只写不读的死状态）', () => {
  const src = read(PANEL_SRC)
  // template 内必须出现这四个符号的渲染（此前全仓只有赋值、零渲染出口）
  const tplStart = src.indexOf('<template>')
  // 根模板末尾用 lastIndexOf：文件内有多个 slot template，首个 </template> 是 slot 的闭合
  const tplEnd = src.lastIndexOf('</template>')
  const tpl = src.slice(tplStart, tplEnd)
  // [card-duration-v1] 耗时已迁到每张卡片头部渲染，template 不再渲染 lastDuration ⇒ 期望列表移除
  for (const sym of ['statusText', 'statusClass', 'runningElapsed']) {
    assert.ok(tpl.includes(sym), `status-bar: template 未渲染 ${sym}（只写不读的死状态回归）`)
  }
  assert.ok(src.includes('status-bar'), '缺少 status-bar 容器标记')
})

// ============ turn 轮回传权归属（turn-feedback-exclusive-v1）============
// [turn-feedback-exclusive-v1] turn 管线在收口后统一回灌 `# turn N 执行结果`；
//   若 ScriptPanel 的旧回传（copyOutput）对同一轮**也**执行 ⇒ 回归为「1 turn = 2 次提问」
//   （实测日志：同一段内 `# turn N 执行结果` 与 `# 脚本执行结果` 交替出现）。
// [VARIANT] 若摘掉 ScriptPanel 的 !turnDrivenRun.value 守卫，或 useTurnRunner 不再标记 turnDriven ⇒ 本条应红。

test('[turn-feedback-exclusive-v1] ScriptPanel 的两处回传分支都必须对 turn 轮让权', () => {
  const guarded = stripComments(read(PANEL_SRC))
  assert.ok(
    guarded.includes('shouldAutoAsk && !turnDrivenRun.value'),
    '主回传分支未对 turn 轮让权（copyOutput 应加 !turnDrivenRun.value 守卫）',
  )
  assert.ok(
    guarded.includes('if (!turnDrivenRun.value) {'),
    '预检失败回传分支未对 turn 轮让权（copyOutput 应加 !turnDrivenRun.value 守卫）',
  )
  assert.ok(
    guarded.includes('turnDrivenRun'),
    'ScriptPanel 未接入 turnDrivenRun（回传权归属判据缺失）',
  )
})

test('[turn-feedback-exclusive-v1] turn 管线把 run 标记为 turnDriven 且 useRunner 如实记账', () => {
  assert.ok(
    read('packages/client/composables/runner/useTurnRunner.ts').includes('turnDriven: true'),
    'useTurnRunner 未把 run 标记为 turnDriven（回传权判据无处生效）',
  )
  const runner = read('packages/client/composables/runner/useRunner.ts')
  assert.ok(
    runner.includes('turnDrivenRun.value = opts?.turnDriven === true'),
    'useRunner 未在 run() 内按 opts.turnDriven 记账（标志不随每轮重置）',
  )
  assert.ok(runner.includes('turnDrivenRun,'), 'useRunner 未导出 turnDrivenRun')
})
