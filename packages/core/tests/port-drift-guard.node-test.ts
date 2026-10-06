// [port-drift-file-v1] 守卫端口漂移通道：服务端写 .server-port + 前端读它
//   单边改动（只写不读或只读不写）会让前后端失联，本测试确保两端同构。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()
const SERVER_SRC = 'apps/standalone/src/server.ts'
const VITE_SRC = 'packages/client/vite.config.ts'

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

test('P1-1: server.ts 启动后写 .ai-runner/.server-port', () => {
  const src = read(SERVER_SRC)
  assert.match(src, /\.server-port/, '缺 .server-port 写入')
  assert.match(src, /renameSync/, '缺原子写 renameSync')
})

test('P1-1: vite.config.ts 读 .server-port 作为 BACKEND 兜底', () => {
  const src = read(VITE_SRC)
  assert.match(src, /\.server-port/, '缺 .server-port 读取')
  assert.match(src, /resolveBackend/, '缺 resolveBackend 函数')
})
