#!/usr/bin/env node
// @desc 一键启动前后端分离双进程：backend + frontend，启动前探活端口避免占用
// @why web SPA 与 API 服务分进程运行；前端 /__ai/* 通过 proxy 转发到后端。
//      Ctrl+C 同时终止两侧，避免孤儿进程。
//      [port-auto-v1] 启动前对 127.0.0.1 探活：若基准端口被占用则递增，显式传给两侧，
//      避免 server.ts 自动切端口后 vite proxy 仍指向旧端口导致 /__ai/* 404。

import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)

const BACKEND_BASE = Number(process.env.AIR_SERVER_PORT) || 5175
const FRONTEND_BASE = Number(process.env.AIR_WEB_PORT) || 5174
const MAX_PORT_TRIES = 20

function tag(prefix, str) {
  return String(str).split('\n').map(l => l ? `[${prefix}] ${l}` : '').join('\n')
}

/**
 * 探测 127.0.0.1 的指定端口是否空闲
 * [WHY] 前端 vite proxy 与后端 listen 需用同一端口；探活后再交给两侧
 * [CONSTRAINT] 用 net.createServer 而非 fetch：探活不求对端响应，只看 bind 是否成功
 * @param {number} port 待检测端口
 * @returns {Promise<boolean>}
 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.unref()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true))
    })
  })
}

/**
 * 从 startPort 起找第一个可用端口
 * [CONSTRAINT] 上限 MAX_PORT_TRIES 防死循环；全占满则抛错由调用方处理
 * @param {number} startPort 基准端口
 * @returns {Promise<number>}
 */
async function findFreePort(startPort) {
  for (let i = 0; i < MAX_PORT_TRIES; i++) {
    const p = startPort + i
    if (await isPortFree(p)) return p
  }
  throw new Error(`从 ${startPort} 起连续 ${MAX_PORT_TRIES} 个端口均被占用`)
}

async function main() {
  const backendPort = await findFreePort(BACKEND_BASE)
  if (backendPort !== BACKEND_BASE) {
    console.warn(`⚠ 后端端口 ${BACKEND_BASE} 被占用，自动切到 ${backendPort}`)
  }
  const frontendPort = await findFreePort(FRONTEND_BASE)
  if (frontendPort !== FRONTEND_BASE) {
    console.warn(`⚠ 前端端口 ${FRONTEND_BASE} 被占用，自动切到 ${frontendPort}`)
  }

  console.log(`启动后端 (port=${backendPort}) ...`)
  const backend = spawn(process.execPath, [path.join(ROOT, 'scripts/dev-server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, AIR_SERVER_PORT: String(backendPort), AIR_SERVER_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  backend.stdout.on('data', d => process.stdout.write(tag('BE', String(d))))
  backend.stderr.on('data', d => process.stderr.write(tag('BE', String(d))))

  console.log(`启动前端 (port=${frontendPort}, backend=${backendPort}) ...`)
  const frontend = spawn('npx', ['vite', '--config', 'packages/client/vite.config.ts', '--port', String(frontendPort), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT,
    env: { ...process.env, AIR_BACKEND_URL: `http://127.0.0.1:${backendPort}` },
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
}

main().catch((e) => {
  console.error(`✗ 启动失败：${e.message || e}`)
  process.exit(1)
})
