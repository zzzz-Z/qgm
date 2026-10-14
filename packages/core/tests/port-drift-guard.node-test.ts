// [port-contract-v1] 端口契约守卫：prod 恒 5175、dev 恒 5274/5275，且不得再有自动漂移。
// [WHY] 2026-10-13 事故：server.ts 端口被占时自动 +1 漂移，客户端与 vite 代理仍指原端口，
//   表现为「服务没挂但全部连不上」，且 .server-port 残留旧值会让 vite 长期代理到错误后端。
//   根除办法是取消漂移 —— 本测试锁死这一点，防止将来又被加回来。
// [CONSTRAINT] 判据落在源码文本上；负向断言（不得含某串）与正向断言（必须含某值）配对，
//   避免「删了代码但测试仍绿」的真空判据。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()
const SERVER_SRC = 'apps/standalone/src/server.ts'
const VITE_SRC = 'packages/client/vite.config.ts'
const DEV_ALL_SRC = 'scripts/dev-all.mjs'

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

test('server.ts 不再写 .server-port（漂移文件机制已移除）', () => {
  const src = read(SERVER_SRC)
  assert.ok(!src.includes('.server-port'), 'server.ts 又写回了 .server-port ⇒ 端口漂移通道复活')
})

test('vite.config.ts 不再读 .server-port（不再依赖漂移值）', () => {
  const src = read(VITE_SRC)
  assert.ok(!src.includes('.server-port'), 'vite.config.ts 又读了 .server-port ⇒ 会吃到历史脏值')
  assert.match(src, /resolveBackend/, '缺 resolveBackend 函数')
})

test('server.ts 不得含端口自动漂移逻辑（EADDRINUSE 必须直接失败）', () => {
  const src = read(SERVER_SRC)
  assert.ok(!/PORT_MAX_TRIES/.test(src), '又出现了 PORT_MAX_TRIES ⇒ 漂移逻辑复活')
  assert.ok(!/nextPort/.test(src), '又出现了 nextPort ⇒ 会自动换端口')
  assert.match(src, /EADDRINUSE/, '应保留 EADDRINUSE 分支（改为报错退出）')
  assert.match(src, /process\.exit\(1\)/, 'EADDRINUSE 时应 exit(1) 明确失败')
})

test('dev 端口与 prod 分离：dev 默认 5275/5274', () => {
  const src = read(DEV_ALL_SRC)
  assert.match(src, /5275/, 'dev 后端默认端口未设为 5275')
  assert.match(src, /5274/, 'dev 前端默认端口未设为 5274')
})

test('prod 端口恒为 5175（不随 dev 改动而变）', () => {
  const eco = read('ecosystem.config.cjs')
  assert.match(eco, /AIR_SERVER_PORT: '5175'/, 'prod 端口契约被改（应恒为 5175）')
})
