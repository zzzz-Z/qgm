import { expect, test } from '@playwright/test'

// 若被 node --test 拾取（NODE_TEST_CONTEXT 由 node 子进程自动设置），立即退出
// 与 client/e2e/baseline-diff.spec.ts 保持同一策略
if (process.env.NODE_TEST_CONTEXT) {
  process.exit(0)
}

// [key-composite-v1] /__ai/workspace/first-prompt 端点契约：model 为可选参，
//   参与复合键 <wsId>::<modelId>；缺省时退化裸 wsId 键。
//   本 spec 只验「按 id+model 读写往返」与「未知工作区 404」，不验业务逻辑。

test('/workspace/first-prompt 缺 id 返回 400', async ({ request }) => {
  const r = await request.get('/__ai/workspace/first-prompt')
  expect(r.status()).toBe(400)
  const j = await r.json()
  expect(j.ok).toBe(false)
})

test('/workspace/first-prompt 未知工作区写返回 404', async ({ request }) => {
  const r = await request.post('/__ai/workspace/first-prompt', {
    data: { id: `nonexistent-${Date.now()}`, model: 'deepseek', sent: true },
  })
  expect(r.status()).toBe(404)
  const j = await r.json()
  expect(j.ok).toBe(false)
})

test('/workspace/first-prompt 有效工作区按 (id, model) 读写往返', async ({ request }) => {
  // 1) 取活跃工作区 id（无工作区则跳过——本环境 standalone 可能尚未选目录）
  const regRes = await request.get('/__ai/workspace/registry')
  expect(regRes.status()).toBe(200)
  const reg = await regRes.json()
  const wsId = String(reg.activeId || '')
  test.skip(!wsId, '无活跃工作区，跳过读写往返（仅覆盖 400/404 分支）')

  const model = 'deepseek'
  // 2) 写 true
  const w1 = await request.post('/__ai/workspace/first-prompt', {
    data: { id: wsId, model, sent: true },
  })
  expect(w1.status()).toBe(200)
  expect((await w1.json()).sent).toBe(true)

  // 3) 读回：同一 model 命中
  const r1 = await request.get(`/__ai/workspace/first-prompt?id=${encodeURIComponent(wsId)}&model=${encodeURIComponent(model)}`)
  expect(r1.status()).toBe(200)
  expect((await r1.json()).sent).toBe(true)

  // 4) 另一 model 不得命中（隔离语义承重）
  const r2 = await request.get(`/__ai/workspace/first-prompt?id=${encodeURIComponent(wsId)}&model=qianwen`)
  expect(r2.status()).toBe(200)
  expect((await r2.json()).sent).toBe(false)

  // 5) 复位：写 false 后读回应为 false（不污染后续运行）
  const w2 = await request.post('/__ai/workspace/first-prompt', {
    data: { id: wsId, model, sent: false },
  })
  expect(w2.status()).toBe(200)
  const r3 = await request.get(`/__ai/workspace/first-prompt?id=${encodeURIComponent(wsId)}&model=${encodeURIComponent(model)}`)
  expect((await r3.json()).sent).toBe(false)
})
