// [jitter-budget-v1] fill 前抖动的**预算守卫**：锁住「每轮固定等待」的量级，防止它悄悄涨回去。
// [WHY] 抖动是纯等待、不产生任何正确性收益，却是无头通道轮间时延的最大单项：
//   2026-10-18 实测 n=109（同口径轮间）p50 14.74s，其中 4.75s 是 jitterDelay(3500,6000)。
//   油猴通道无此等待，同口径 p50 7.04s。差额 7.7s → 62% 由这一个常量对造成。
//   声明式「不该等这么久」没有守卫就等于没有约束：它曾在无人察觉的情况下吃掉近三分之一的吞吐。
// [CONSTRAINT] 读的是源码 SSOT（非运行态），与 module-size-ratchet.node-test.ts / system-contract 同法：
//   headless-constants.ts 会 import ../config.js（含环境相关副作用），故不 import 实体，只解析字面量。
// [CONSTRAINT] 断言必须成对：只锁常量值会漏掉「有人把自适应摘掉」，
//   只锁自适应会漏掉「有人把常量调回 3500」。两条缺一都让守卫变真空。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

const CONSTANTS = 'packages/core/src/headless/headless-constants.ts'
const HEADLESS = 'packages/core/src/headless/ai-headless.ts'

/** 从源码抽出 `export const NAME = <num>` 的数值；抽不到直接抛，避免正则失配变成静默通过 */
function constValue(src: string, name: string): number {
  const m = src.match(new RegExp(`export const ${name} = (\\d[\\d_]*)`))
  if (!m) throw new Error(`未找到常量 ${name}（源码结构变了？守卫正则需同步）`)
  return Number(m[1].replace(/_/g, ''))
}

describe('[jitter-budget-v1] fill 前抖动预算', () => {
  const src = read(CONSTANTS)
  const min = constValue(src, 'DEFAULT_JITTER_MIN_MS')
  const max = constValue(src, 'DEFAULT_JITTER_MAX_MS')

  it('下限落在 [400, 1500]：低于油猴 doSend 的一次回执节奏(700ms) 起步，高于「完全不抖」', () => {
    // [WHY 400] 油猴 doSend 是 300ms(等渲染) + 400ms(首检) = 700ms 才出回执；
    //   本通道不要求比它更慢，但也不允许退化成 0（0 会连抖动语义一起丢掉，退化为纯脚本节奏）。
    expect(min).toBeGreaterThanOrEqual(400)
    expect(min).toBeLessThanOrEqual(1500)
  })

  it('上限落在 [400, 2000]，且与下限保持真实抖动区间（max >= min * 1.5）', () => {
    expect(max).toBeGreaterThanOrEqual(400)
    expect(max).toBeLessThanOrEqual(2000)
    expect(max).toBeGreaterThanOrEqual(min * 1.5)
  })

  it('旧的 3500/6000 字面量不得残留（防半改：一处改了另一处又写回去）', () => {
    expect(src).not.toMatch(/DEFAULT_JITTER_(?:MIN|MAX)_MS = 3500/)
    expect(src).not.toMatch(/DEFAULT_JITTER_(?:MIN|MAX)_MS = 6000/)
  })

  it('频控自适应仍在：rateLimitedRatio 超阈值时翻倍，接在 jitterDelay 的实参上', () => {
    // [CONSTRAINT] 降常量后 jitter 不再能独自吸收频控，自适应是唯一兜底 —— 它被摘掉就只剩被动退避。
    const h = read(HEADLESS)
    expect(h).toMatch(/rateLimitedRatio\(\)/)
    expect(h).toMatch(/ratio\s*>\s*0\.1\s*\?\s*2\s*:\s*1/)
    expect(h).toMatch(/jitterDelay\(\s*jitterMin\s*\*\s*scale\s*,\s*jitterMax\s*\*\s*scale\s*\)/)
  })

  it('抖动实参仍取自常量而非硬编码（防止常量被架空后守卫假绿）', () => {
    const h = read(HEADLESS)
    expect(h).toMatch(/opts\.jitterMin\s*\|\|\s*DEFAULT_JITTER_MIN_MS/)
    expect(h).toMatch(/opts\.jitterMax\s*\|\|\s*DEFAULT_JITTER_MAX_MS/)
  })

  it('单轮固定等待预算：jitter 上限 + fill 校验宽限 不超过 4s', () => {
    // [WHY] 这两项串在每轮的关键路径上（校验宽限 = FILL_VERIFY_GRACE_MS）。
    //   预算上限防的是「常量合法但组合起来又变回 6s」——单项守卫拦不住组合退化。
    const h = read(HEADLESS)
    const grace = h.match(/const FILL_VERIFY_GRACE_MS = (\d[\d_]*)/)
    expect(grace, 'FILL_VERIFY_GRACE_MS 未找到').toBeTruthy()
    const graceMs = Number(String(grace[1]).replace(/_/g, ''))
    expect(max + graceMs).toBeLessThanOrEqual(4000)
  })
})
