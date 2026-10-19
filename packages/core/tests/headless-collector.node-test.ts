// [headless-collector-v1] 三通道 observer + 信号驱动等待的契约守卫。
// [WHY] observer 在导航/新会话后失效会让 waitForSignal 退化为纯轮询（不丢回复但变慢）；
//   若前置重装逻辑被删，采集延迟会静默回到旧水平且无任何报错——正是本项目最贵的一类失效。
// 承重：删 ensureCollectorInPage 调用 / 删 _collectorReady 写入 / 静默窗 < 350 均应变红。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const INJECT = path.join(ROOT, 'packages/core/src/headless/headless-inject.ts')
const HEADLESS = path.join(ROOT, 'packages/core/src/headless/ai-headless.ts')
const FENCE_SRC = path.join(ROOT, 'packages/core/src/tampermonkey/observer.ts')

test('collector: observer 必须三通道且写 _lastMutationAt', () => {
  const s = fs.readFileSync(INJECT, 'utf8')
  assert.ok(/childList:\s*true,\s*subtree:\s*true,\s*characterData:\s*true,\s*attributes:\s*true/.test(s), 'observer 必须同时监听 childList/characterData/attributes（缺 attributes 会漏按钮态变化）')
  assert.ok(/dedup\._lastMutationAt\s*=\s*Date\.now\(\)/.test(s), 'observer 回调必须记 _lastMutationAt')
  assert.ok(/dedup\._collectorReady\s*=\s*true/.test(s), 'observe 成功后必须置 _collectorReady')
})

test('collector: ensureCollectorInPage 必须幂等且可重装', () => {
  const s = fs.readFileSync(INJECT, 'utf8')
  assert.ok(/export function ensureCollectorInPage\(\)/.test(s), '必须导出 ensureCollectorInPage')
  assert.ok(/if \(dedup\._collectorReady && dedup\._observer && document\.body\) return true/.test(s), '已就绪必须直接返回，不得重复 observe（叠加回调会让 _bodyVersion 涨速翻倍）')
  assert.ok(/dedup\._observer\.disconnect\(\)/.test(s), '重装前必须 disconnect 旧 observer')
})

test('collector: fillPrompt 前必须检查并重装', () => {
  const s = fs.readFileSync(HEADLESS, 'utf8')
  assert.ok(/if \(!ready\)/.test(s), 'collector 未就绪必须触发重装')
  assert.ok(/page\.evaluate\(ensureCollectorInPage\)/.test(s), '重装必须调 ensureCollectorInPage')
})

test('collector: 静默窗 >= 350ms（不得早于油猴防抖）', () => {
  const s = fs.readFileSync(HEADLESS, 'utf8')
  const m = /const SILENCE_MS = (\d+)/.exec(s)
  assert.ok(m, 'waitForSignal 必须定义 SILENCE_MS')
  assert.ok(Number(m[1]) >= 350, `静默窗 ${m[1]}ms < 350ms，会比油猴更早交付半截正文`)
  const mx = /const MAX_WAIT_MS = (\d+)/.exec(s)
  assert.ok(mx && Number(mx[1]) <= 1000, 'MAX_WAIT_MS 不得超过 1000ms（超时告警依赖它及时触发）')
})

test('collector: 油猴副本注释已同步契约说明', () => {
  const s = fs.readFileSync(FENCE_SRC, 'utf8')
  assert.ok(s.includes('headless-collector-v1'), '油猴副本必须注明稳定契约同步说明（逐字同构要求）')
  assert.ok(/静默窗特意设为 400ms/.test(s), '必须写明 400ms >= 350ms 的理由')
})

test('collector: 短回复闸门已退役 _stableCount<6，只保留 isGeneratingInPage', () => {
  const s = fs.readFileSync(INJECT, 'utf8')
  // [headless-collector-v1] 新模型由 waitForSignal 静默窗保证稳定，轮询时代的「连续 6 拍」补偿已无意义。
  // 承重：把 `_stableCount < 6` 加回去即变红。
  assert.ok(!/\(dedup\._stableCount \|\| 0\) < 6/.test(s), '_stableCount < 6 应已退役（静默窗已隐含稳定）')
  assert.ok(/if \(_h && isGeneratingInPage\(\)\)/.test(s), 'isGeneratingInPage 那一半必须保留（防生成中推半截）')
  assert.ok(/_shortSentHash/.test(s), '短回复去重必须仍由 _shortSentHash 承担')
})

test('collector: waitForSignal 必须是模块级函数而非 pool 方法', () => {
  const s = fs.readFileSync(HEADLESS, 'utf8')
  assert.ok(/async function waitForSignal\(sid: string\)/.test(s), 'waitForSignal 必须是模块级函数')
  assert.ok(!/^\s+async waitForSignal\(/m.test(s), '不得作为 pool 对象方法（不在 HeadlessPool 类型内）')
})
