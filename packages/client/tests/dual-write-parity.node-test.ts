// [dual-write-parity-v1] 三处「刻意的双写实现」必须保持一致。
// [WHY] 本仓有多处「一份在服务端、一份在浏览器裸跑」的同构实现，注释写着「改一处必须同步另一处」，
//   但此前无任何测试保证——本会话就实测到 turn-emit.ts 漏 mode、WorkspaceItem 类型漂移。
// [CONSTRAINT] 用源码解析而非 import：两侧运行环境不同（core 是 node、client 需要浏览器桩）。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'vitest'

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')

describe('双写实现一致性（dual-write-parity-v1）', () => {
  it('turn-mode：core deriveTurnMode 与 client collectTurnMode 判定一致', () => {
    const core = read('../../core/src/reply/turn-frames.ts')
    const client = read('../composables/runner/turn-collect.ts')
    const RE = /awaiting === 'none' \? 'summary' : awaiting/
    assert.ok(RE.test(core), 'core 侧 turn-mode 判定形态变了，需同步本守卫')
    assert.ok(RE.test(client), 'client 侧 turn-mode 判定与 core 漂移了')
  })

  it('workspace 条目：client WorkspaceItem 的 firstPromptSent 必须与 core 同形', () => {
    const core = read('../../core/src/workspace-store.ts')
    const client = read('../composables/data/useWorkspaces.ts')
    const coreAllowsObject = /firstPromptSent\?:\s*Record<string,\s*boolean\s*\|\s*\{/.test(core)
    const clientAllowsObject = /firstPromptSent\?:\s*Record<string,\s*boolean\s*\|\s*\{/.test(client)
    assert.equal(clientAllowsObject, coreAllowsObject, 'firstPromptSent 类型两侧必须同形（对象形态曾是真实漂移点）')
  })

  it('script 卡片：timeline-build 与 TerminalPane 的字段集一致', () => {
    const tl = read('../utils/timeline-build.ts')
    const tp = read('../components/script/TerminalPane.vue')
    for (const f of ['reason', 'durationMs']) {
      assert.ok(tl.includes(f), `timeline-build 缺字段 ${f}`)
      assert.ok(tp.includes(f), `TerminalPane 缺字段 ${f}（与 timeline-build 漂移）`)
    }
  })
})
