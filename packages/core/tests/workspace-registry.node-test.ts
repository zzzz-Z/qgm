// [multi-workspace-v1] 承重测试：工作区注册表（幂等入册 / 激活 / 移除含活跃项回退）
//   + ALS root 作用域（runWithWorkspace 内 getRoot 按请求隔离）+ workspace.json 持久化往返（含旧格式迁移）。
// [CONSTRAINT] 测试必须与真实 ~/.ai-runner 隔离：AI_RUNNER_WORKSPACE_CONF_DIR 指向临时目录，
//   且 config.ts 在模块顶层读该 env ⇒ 必须先设 env 再动态 import（配合 vi.resetModules 得到干净实例）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, it, vi } from 'vitest'

let confDir: string
let tmpRoot: string

beforeEach(() => {
  confDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-runner-ws-conf-'))
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-runner-ws-root-'))
  process.env.AI_RUNNER_WORKSPACE_CONF_DIR = confDir
  vi.resetModules()
})

afterEach(() => {
  delete process.env.AI_RUNNER_WORKSPACE_CONF_DIR
  fs.rmSync(confDir, { recursive: true, force: true })
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

it('注册幂等：同路径重复注册返回同一条目；label 取 basename；首个注册自动激活', async () => {
  const cfg = await import('../src/config.js')
  const a = cfg.registerWorkspace(tmpRoot)
  const b = cfg.registerWorkspace(path.join(tmpRoot, 'sub', '..'))
  assert.equal(a.id, b.id, '同路径（含冗余段）必须派生同一 id')
  assert.equal(a.label, path.basename(tmpRoot))
  assert.equal(cfg.getActiveWorkspaceId(), a.id)
  assert.equal(cfg.getHasWorkspace(), true)
  assert.equal(cfg.getRoot(), path.resolve(tmpRoot), '激活必须落到 setRoot 原语')
  assert.equal(cfg.getWorkspaces().length, 1, '注册表不得因重复注册膨胀')
})

it('[workspace-remove-active-v1] 活跃工作区可移除：自动回退到剩余项；无剩余则清空', async () => {
  const cfg = await import('../src/config.js')
  const a = cfg.registerWorkspace(tmpRoot, true)
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-runner-ws-b-'))
  try {
    const b = cfg.registerWorkspace(other, false)
    // 非活跃项：可直接移除，活跃态不受影响
    const r1 = cfg.removeWorkspace(b.id)
    assert.equal(r1.ok, true, '非活跃项必须可移除')
    assert.equal(cfg.getActiveWorkspaceId(), a.id, '移除非活跃项不得影响活跃态')
    // 活跃项：可移除并自动回退（本例已无剩余项 → 清空 + hasWorkspace=false）
    const r2 = cfg.removeWorkspace(a.id)
    assert.equal(r2.ok, true, '活跃项也必须可移除（auto-fallback 语义）')
    assert.equal(cfg.getWorkspaces().length, 0)
    assert.equal(cfg.getActiveWorkspaceId(), null, '无剩余项时 activeId 必须置 null')
    assert.equal(cfg.getHasWorkspace(), false, '无剩余项时必须回落引导页状态')
  } finally {
    fs.rmSync(other, { recursive: true, force: true })
  }
})

it('[workspace-session-bind-v1] sessions 读写往返：set 后可读、落盘后 load 仍可读', async () => {
  const cfg = await import('../src/config.js')
  const a = cfg.registerWorkspace(tmpRoot, true)
  assert.equal(cfg.getWorkspaceSession(a.id), null, '初始无绑定')
  const ok = cfg.setWorkspaceSession(a.id, { url: 'https://chat.deepseek.com/a/chat/s/abc', sessionId: 'abc' })
  assert.equal(ok, true, '已注册工作区写入应成功')
  assert.equal(cfg.getWorkspaceSession(a.id)?.sessionId, 'abc')
  // 模拟重启：resetModules 后从磁盘恢复
  vi.resetModules()
  const cfg2 = await import('../src/config.js')
  cfg2.loadWorkspaceRegistry()
  assert.equal(cfg2.getWorkspaceSession(a.id)?.url, 'https://chat.deepseek.com/a/chat/s/abc', '重启后绑定应恢复')
})

it('[workspace-session-bind-v1] 绑定约束：未注册工作区写入被拒；出册时绑定被清', async () => {
  const cfg = await import('../src/config.js')
  const a = cfg.registerWorkspace(tmpRoot, true)
  assert.equal(cfg.setWorkspaceSession('nope-id', { url: 'x', sessionId: 'y' }), false, '未注册工作区必须拒绝写入')
  cfg.setWorkspaceSession(a.id, { url: 'https://x/1', sessionId: '1' })
  assert.equal(cfg.getWorkspaceSession(a.id)?.sessionId, '1')
  cfg.removeWorkspace(a.id)
  assert.equal(cfg.getWorkspaceSession(a.id), null, '出册必须清绑定')
})

it('ALS 作用域：runWithWorkspace 内 getRoot/resolveScopedRoot 解析为作用域 root，外部不受影响', async () => {
  const cfg = await import('../src/config.js')
  const scope = await import('../src/workspace-scope.js')
  cfg.registerWorkspace(tmpRoot)
  const scoped = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-runner-ws-scope-'))
  try {
    const inside = await scope.runWithWorkspace({ workspaceId: 'ws-test', root: scoped }, async () => {
      assert.equal(scope.getScopeWorkspaceId(), 'ws-test')
      return {
        root: cfg.getRoot(),
        scopedRoot: scope.resolveScopedRoot(),
      }
    })
    assert.equal(inside.root, scoped, '作用域内 getRoot 必须解析为作用域 root（38 处消费点的隔离依据）')
    assert.equal(inside.scopedRoot, scoped)
    assert.equal(scope.getScopeWorkspaceId(), null, '作用域外不得泄漏 workspaceId')
    assert.equal(cfg.getRoot(), path.resolve(tmpRoot), '作用域外回落活跃 ROOT')
  } finally {
    fs.rmSync(scoped, { recursive: true, force: true })
  }
})

it('resolveScopedRoot 回落链：无作用域时 env.AI_RUNNER_ROOT 优先于 cwd（env 旁路语义不变）', async () => {
  const scope = await import('../src/workspace-scope.js')
  const prev = process.env.AI_RUNNER_ROOT
  try {
    process.env.AI_RUNNER_ROOT = tmpRoot
    assert.equal(scope.resolveScopedRoot(), tmpRoot)
    // [CONSTRAINT] 不能用 `process.env.X = undefined`（会存成字符串 'undefined'），必须 delete
    delete process.env.AI_RUNNER_ROOT
    assert.equal(scope.resolveScopedRoot(), process.cwd())
  } finally {
    if (prev !== undefined) process.env.AI_RUNNER_ROOT = prev
  }
})

it('持久化往返：注册落盘，重启（重导入）后 loadWorkspaceRegistry 恢复并激活', async () => {
  const cfg1 = await import('../src/config.js')
  const a = cfg1.registerWorkspace(tmpRoot, true)
  vi.resetModules()
  const cfg2 = await import('../src/config.js')
  const restored = cfg2.loadWorkspaceRegistry()
  assert.equal(restored, path.resolve(tmpRoot))
  assert.equal(cfg2.getActiveWorkspaceId(), a.id)
  assert.equal(cfg2.getWorkspaces().length, 1)
})

it('旧格式迁移：workspace.json 只有 {root} 时自动转为单条注册并激活', async () => {
  fs.writeFileSync(path.join(confDir, 'workspace.json'), JSON.stringify({ root: tmpRoot, at: Date.now() }))
  vi.resetModules()
  const cfg = await import('../src/config.js')
  const restored = cfg.loadWorkspaceRegistry()
  assert.equal(restored, path.resolve(tmpRoot))
  assert.equal(cfg.getWorkspaces().length, 1, '旧格式必须迁移为注册表条目')
  assert.equal(cfg.getActiveWorkspaceId(), cfg.getWorkspaces()[0]?.id)
})

it('损坏与缺失：workspace.json 缺失/损坏时 loadWorkspaceRegistry 返回 null 且不抛错', async () => {
  vi.resetModules()
  const cfg = await import('../src/config.js')
  assert.equal(cfg.loadWorkspaceRegistry(), null, '无配置文件 → null')
  fs.writeFileSync(path.join(confDir, 'workspace.json'), '{not-json')
  assert.equal(cfg.loadWorkspaceRegistry(), null, '损坏 JSON → null（按无注册处理）')
})
