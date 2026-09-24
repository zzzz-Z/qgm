#!/usr/bin/env node
// @desc 一键启动前后端分离双进程：backend(5175) + frontend(5174)。
// @why web SPA 与 API 服务分进程运行；前端 /__ai/* 通过 proxy 转发到后端。
//      Ctrl+C 同时终止两侧，避免孤儿进程。

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)

const BACKEND_PORT = process.env.AIR_SERVER_PORT || '5175'
const FRONTEND_PORT = process.env.AIR_WEB_PORT || '5174'

function tag(prefix, str) {
  return String(str).split('\n').map(l => l ? `[${prefix}] ${l}` : '').join('\n')
}

console.log(`启动后端 (port=${BACKEND_PORT}) ...`)
const backend = spawn(process.execPath, [path.join(ROOT, 'scripts/dev-server.mjs')], {
  cwd: ROOT,
  env: { ...process.env, AIR_SERVER_PORT: BACKEND_PORT, AIR_SERVER_HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
backend.stdout.on('data', d => process.stdout.write(tag('BE', String(d))))
backend.stderr.on('data', d => process.stderr.write(tag('BE', String(d))))

console.log(`启动前端 (port=${FRONTEND_PORT}) ...`)
const frontend = spawn('npx', ['vite', '--config', 'packages/client/vite.config.ts', '--port', FRONTEND_PORT, '--strictPort', '--host', '127.0.0.1'], {
  cwd: ROOT,
  env: { ...process.env, AIR_BACKEND_URL: `http://127.0.0.1:${BACKEND_PORT}` },
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
})
frontend.stdout.on('data', d => process.stdout.write(tag('FE', String(d))))
frontend.stderr.on('data', d => process.stderr.write(tag('FE', String(d))))

function shutdown() {
  console.log('关闭中...')
  for (const c of [backend, frontend]) {
    try { c.kill('SIGTERM') } catch { /* ignore */ }
  }
  setTimeout(() => {
    for (const c of [backend, frontend]) {
      try { if (!c.killed) c.kill('SIGKILL') } catch { /* ignore */ }
    }
    process.exit(0)
  }, 800)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
backend.on('exit', (code) => { if (code !== 0 && code !== null) { console.error(`[BE] 退出码 ${code}`); shutdown() } })
frontend.on('exit', (code) => { if (code !== 0 && code !== null) { console.error(`[FE] 退出码 ${code}`); shutdown() } })
