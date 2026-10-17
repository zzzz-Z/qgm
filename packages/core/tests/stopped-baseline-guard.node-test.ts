// [stopped-btn-parity-v1] 双通道 stopped 按钮化 parity 守卫（2026-10-16 由关键词基线守卫演进）。
//
// 沿革：本文件原守「已停止」关键词正则的三处内联同构（headless 冷启动基线 + 主判定 + reset）。
//   2026-10-16 复检实测：那三个词（当前问题已停止|已停止生成|已停止回答）在 DeepSeek 线上
//   bundle（main.a0ce88b684.js，commit fd5d6ec3）里**零命中**（真实角标是 已停止/思考已停止/
//   搜索已停止）⇒ 关键词探针零真阳性；而 AI 在正文里复述这三个词即误推 stopped（2026-10-15
//   实测）⇒ 纯假阳性通道。两侧同步改为按钮状态驱动：
//   · 油猴 scripts/tampermonkey-session-id.user.js [stopped-btn-v1]/[stopped-btn-v2]
//   · headless headless-inject.ts detectReplyInPage 内联 isGeneratingInPage [stopped-btn-v1]
//
// 本守卫守四件事：
//   ① headless 侧探针常量与油猴侧逐值一致（STOP_LABEL_RE / 可点击选择器 / 圆钮选择器 /
//      DS 图签名锚点 / scope closest 列表）——两侧各一份内联副本（page.evaluate 序列化约束），
//      值分叉即行为分叉；
//   ② headless 判定结构在位：isGeneratingInPage + _prevGenBtn 过渡 + 无新增内容条件；
//   ③ 位置约束：stopped 判定必须在基线 hash 守卫**之前**——「没产出任何回复块」正是该守卫会
//      return null 的形态，挪到其后则思考期被停永远推不出 stopped；
//   ④ 关键词 stopped 代码形态两通道均不得回潮（含 reset 侧 _STOPPED_ANCHOR_RR /
//      _stoppedBaseline——复活它们会同时带回冷启动误报与自指假阳性两个历史缺陷）。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import vm from 'node:vm'

const ROOT = process.cwd()
const USERSCRIPT = 'scripts/tampermonkey-session-id.user.js'
const INJECT = 'packages/core/src/headless/headless-inject.ts'
const INJECT_SIMPLE = 'packages/core/src/headless/headless-fill.ts'

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

/** 抠出 `function <name>(...) { <inner> }` 的花括号内部（与 stopped-btn-guard 同构） */
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
    }
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return src.slice(braceAt + 1, i)
    }
  }
  throw new Error(`${name} 花括号不配平`)
}

/** 抠出 `const STOP_LABEL_RE = <literal>` 的正斜杠字面量（两侧同名同形） */
function extractStopLabelRe(src: string): string {
  const m = src.match(/const STOP_LABEL_RE = (\/[\s\S]*?\/i)/)
  assert.ok(m, '未找到 STOP_LABEL_RE 声明')
  return m[1]
}

/** 抠出 DS 图签名锚点数组字面量（油猴叫 DS_STOP_ICON_ANCHORS，headless 叫 dsAnchors） */
function extractDsAnchors(src: string): string {
  const m = src.match(/const (?:DS_STOP_ICON_ANCHORS|dsAnchors) = (\[[^\]]*\])/)
  assert.ok(m, '未找到 DS 图签名锚点数组声明')
  return m[1]
}

test('stopped parity: 两侧探针常量逐值一致（标签正则 / 可点击选择器 / 圆钮选择器 / 图签名锚点 / scope 列表）', () => {
  const us = read(USERSCRIPT)
  const hl = read(INJECT)

  // ① 标签正则
  assert.equal(
    extractStopLabelRe(hl),
    extractStopLabelRe(us),
    'headless 与油猴的 STOP_LABEL_RE 不一致：同形不同值会让两通道「何时算在生成」分叉',
  )

  // ② 可点击元素选择器（两侧均声明为 const sel = '...'）
  const usSel = us.match(/const sel = '(button, div\[role\][^']*)'/)
  const hlSel = hl.match(/const sel = '(button, div\[role\][^']*)'/)
  assert.ok(usSel, '油猴侧未找到可点击元素选择器声明')
  assert.ok(hlSel, 'headless 侧未找到可点击元素选择器声明')
  assert.equal(hlSel[1], usSel[1], '可点击元素选择器两通道不一致')

  // ③ 圆钮选择器（油猴内联两处、headless 声明为 circleSel）
  const CIRCLE = '[role="button"].ds-button--circle, button.ds-button--circle'
  assert.ok(us.includes(`'${CIRCLE}'`), '油猴侧圆钮选择器缺失')
  const hlCircle = hl.match(/const circleSel = '([^']*)'/)
  assert.ok(hlCircle, 'headless 侧未找到 circleSel 声明')
  assert.equal(hlCircle[1], CIRCLE, 'headless 圆钮选择器与油猴不一致')

  // ④ DS 图签名锚点
  assert.equal(
    extractDsAnchors(hl),
    extractDsAnchors(us),
    'headless 与油猴的 DS 图签名锚点不一致：一侧改版另一侧失明，双通道 stopped 行为分叉',
  )

  // ⑤ scope closest 列表（[stop-btn-scope-v1] 的输入区收敛，两侧同形）
  const usClosest = us.match(/\.closest\('(form, \[class\*="input"\][^']*)'\)/)
  const hlClosest = hl.match(/\.closest\('(form, \[class\*="input"\][^']*)'\)/)
  assert.ok(usClosest, '油猴侧未找到 scope closest 列表')
  assert.ok(hlClosest, 'headless 侧未找到 scope closest 列表')
  assert.equal(hlClosest[1], usClosest[1], 'scope closest 列表两通道不一致')

  // [stopped-marker-v2] 油猴侧同构：判据必须是「根冻结 || 继续按钮 || 已停止角标」
  assert.ok(
    us.includes('const stoppedByBtn = hasContinueBtn()'),
    '油猴侧必须探测「继续生成」按钮（已产出内容后自停的信号之一）',
  )
  assert.ok(
    us.includes('const stoppedByLabel = hasStoppedLabel()'),
    '油猴侧必须探测「已停止」角标：有产出 + 无继续按钮的形态只能靠它识别',
  )
  assert.ok(
    us.includes('if (rootsFrozen || stoppedByBtn || stoppedByLabel)'),
    '油猴 stopped 判据必须三通道齐全，只保留前两条会漏判「仅已停止角标」的形态',
  )
  assert.ok(
    us.includes('function hasContinueBtn()'),
    '油猴侧必须定义 hasContinueBtn（与 headless detectStoppedMarkersInPage 的 byBtn 同构）',
  )
  assert.ok(
    us.includes('function hasStoppedLabel()'),
    '油猴侧必须定义 hasStoppedLabel（精确等值 + 排除正文 + 要求 svg）',
  )
})

test('stopped parity: headless 判定结构在位（isGeneratingInPage + 按钮过渡 + 无新增内容）', () => {
  const hl = read(INJECT)
  assert.ok(hl.includes('function isGeneratingInPage()'), 'headless 必须内联按钮状态探针（page.evaluate 序列化约束）')
  assert.ok(hl.includes('const wasGen = dedup._prevGenBtn === true'), '判定必须基于「上一 poll 在生成」的过渡')
  assert.ok(hl.includes('dedup._prevGenBtn = currGen'), '必须每 poll 更新按钮状态供下一 poll 判过渡')
  // [CONSTRAINT] 断言**消费点整串**（不只是声明）：只钉 `const wasGen = ...` 而漏掉 if 条件里的
  //   `wasGen &&`，变异删掉过渡条件后测试仍绿（2026-10-16 变异实测存活过一次，补此断言）。
  // [stopped-marker-v2] 判据有三条分支，缺任一即漏判某类平台自停：
  //   ① 按钮从有到无 + 无新增内容（思考期被停）② 继续按钮 ③ 已停止角标（无继续按钮时的唯一信号）
  // [判据承重] 删掉任一分支 ⇒ 下方断言必红。
  assert.ok(
    hl.includes('|| markers.byBtn || markers.byLabel'),
    'stopped 必须三通道齐全（按钮过渡 + 继续按钮 + 已停止角标），缺一即漏判一类平台自停',
  )
  assert.ok(
    hl.includes('noNewAssistantContent(dedup._baselineLastHash, hashLastAssistant())'),
    'stopped 必须要求「本轮无新增 assistant 内容」（与油猴 rootsFrozenNow 同义），且经 noNewAssistantContent 纯函数判定',
  )
  assert.ok(
    hl.includes('function detectStoppedMarkersInPage()'),
    'headless 必须内联合并探针（page.evaluate 序列化约束，一次扫出 byBtn 与 byLabel）',
  )
  // 文案正则必须非捕获组：捕获组会触发 regexp/no-unused-capturing-group（实际挂过 lint）
  assert.ok(
    hl.includes('/^(?:继续生成|继续回答|继续输出|Continue generating)$/i'),
    '继续按钮文案正则必须用非捕获组，且限定四种精确文案（裸「继续」会命中正文）',
  )

  const simple = read(INJECT_SIMPLE)
  assert.ok(simple.includes('_prevGenBtn: false'), 'resetReplyDedupInPage 必须把「上一 poll 在生成」清成 false（冷启动不当成过渡）')
})

test('stopped parity: noNewAssistantContent 判据行为（无基线保守不推；hash 未变才推）', () => {
  // [stopped-btn-v1] 该纯函数是 headless stopped 判定的核心条件，行为规格：
  const hl = read(INJECT)
  const inner = extractInner(hl, 'noNewAssistantContent')
  const noNew = vm.runInNewContext(`(function (baselineHash, nowHash) { ${inner} })`, {}) as unknown as (
    baselineHash: string,
    nowHash: string,
  ) => boolean
  // 空会话/未 fill：基线是 '' 哨兵 ⇒ 无基线可比，保守不推（避免注入瞬间误报）
  assert.equal(noNew('', ''), false, '无基线时必须保守不推 stopped')
  assert.equal(noNew('', 'abc'), false, '无基线时即使有内容也不推（基线缺失不可比）')
  // hash 未变 ⇒ 本轮没产出任何回复块（思考阶段被停/平台中断）⇒ 可推
  assert.equal(noNew('abc123', 'abc123'), true, '最后一条消息 hash 未变必须判「无新增内容」')
  // 无 assistant 根（哨兵 ''）⇒ 同样无产出
  assert.equal(noNew('abc123', ''), true, '无 assistant 根时判「无新增内容」')
  // hash 变了 ⇒ 有新增内容（正常完成或半截中断）⇒ 不推（交由 done/script/plain 分发）
  assert.equal(noNew('abc123', 'def456'), false, '有新增内容时不得推 stopped')
})

test('stopped parity: headless stopped 判定位于基线 hash 守卫之前（思考期被停的形态不被吞）', () => {
  const hl = read(INJECT)
  const stopIdx = hl.indexOf('dedup._prevGenBtn = currGen')
  const guardIdx = hl.indexOf('if (typeof dedup._baselineLastHash === \'string\')')
  assert.ok(stopIdx > 0, '未找到 stopped 按钮过渡判定')
  assert.ok(guardIdx > 0, '未找到基线 hash 守卫')
  assert.ok(
    stopIdx < guardIdx,
    'stopped 判定被挪到基线 hash 守卫之后：「没产出任何回复块」的停止形态会被守卫 return null 吞掉',
  )
})

test('stopped parity: 关键词 stopped 代码形态两通道均不得回潮', () => {
  const us = read(USERSCRIPT)
  const hl = read(INJECT)
  const simple = read(INJECT_SIMPLE)
  // [WHY] 这三个词在 DeepSeek 真实角标零命中（bundle 实证）⇒ 关键词探针只剩自指假阳性；
  //   复活任何一处都会把 2026-10-15 的误报（脚本被 stopped-window 闸门拦截）带回来。
  // [CONSTRAINT] 只查代码形态（match 调用 / 锚点变量 / 基线字段），不查裸词——两侧的墓碑
  //   注释为说明历史刻意引述了这些词，按裸词断言会把墓碑本身判红。
  const HL_FORMS = [
    'scanText.match(/当前问题已停止',
    '_STOPPED_ANCHOR_RR',
    'dedup._stoppedBaseline',
  ]
  for (const form of HL_FORMS) {
    assert.ok(!hl.includes(form), `headless 关键词 stopped 代码形态 ${form} 不得回潮`)
    assert.ok(!simple.includes(form), `headless-fill 关键词 stopped 代码形态 ${form} 不得回潮`)
  }
  // 油猴侧死码形态由 stopped-btn-guard 的专用例守（countStopMarkers 等 7 种），此处不重复
  assert.ok(!us.includes('scanText.match(/当前问题已停止'), '油猴侧关键词 stopped 不得回潮')
})
