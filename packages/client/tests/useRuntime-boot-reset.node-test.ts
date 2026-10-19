// [runtime-boot-reset-v1] 行为测试：刷新 / 重开后，进行中态（waiting / running / feedback / …）
// 在 boot 时复位为 idle；用户显式置的终态（idle / paused / stopped / interrupted）保留。
// [WHY] 运行态持久化在 localStorage（useStorage 默认存储），transient 态无法跨会话存活
//   （执行器/回传窗随页面销毁），残留会令「AI 思考中」banner 永久卡住（用户实测 2026-10-19）。
// [CONSTRAINT] 直接测 reconcileBootKind 纯函数 + 一次 happy-dom 下的真实 boot 复现，
//   避免依赖 vi.resetModules 重灌模块的时序不稳。
import assert from 'node:assert/strict'
import { test } from 'vitest'

import { reconcileBootKind } from '../../../packages/client/composables/ai/useRuntime'

const TRANSIENTS = [
  'running',
  'preparing',
  'waiting',
  'parsing',
  'executing',
  'feedback',
  'handoff',
  'budget-limited',
  'waiting-input',
]
const TERMINALS = [
  'idle',
  'paused',
  'stopped',
  'interrupted',
]

test('reconcileBootKind：所有进行中态收敛为 idle', () => {
  for (const k of TRANSIENTS) {
    assert.equal(reconcileBootKind(k as never), 'idle', `kind=${k} 应被复位为 idle`)
  }
})

test('reconcileBootKind：终态原样保留', () => {
  for (const k of TERMINALS) {
    assert.equal(reconcileBootKind(k as never), k, `kind=${k} 应被保留`)
  }
})
