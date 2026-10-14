#!/usr/bin/env node
// @desc 一键启动前后端分离双进程：backend + frontend，启动前探活端口
// @why web SPA 与 API 服务分进程运行；前端 /__ai/* 通过 proxy 转发到后端。
//      Ctrl+C 同时终止两侧，避免孤儿进程。
//      [port-kill-v1] 启动前对 127.0.0.1 探活：若基准端口被占用则 kill 占用进程，
//      释放后仍用原端口启动，避免自动切端口后 vite proxy 指向旧端口导致 /__ai/* 404。

import { execSync, spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)

// [dev-port-isolation-v1] dev 默认用 5275/5274，与 prod(5175) 隔开，避免抢端口
const BACKEND_BASE = Number(process.env.AIR_SERVER_PORT) || 5275
const FRONTEND_BASE = Number(process.env.AIR_WEB_PORT) || 5274
const MAX_KILL_TRIES = 5

function tag(prefix, str) {
  return String(str).split('\n').map(l => l ? `[${prefix}] ${l}` : '').join('\n')
}

/**
 * 探测 127.0.0.1 的指定端口是否空闲
 * [WHY] 前端 vite proxy 与后端 listen 需用同一端口；探活后再交给两侧
 * [CONSTRAINT] 用 net.createServer 而非 fetch：探活不求对端响应，只看 bind 是否成功
 * @param {number} port 待检测端口
 * @returns {Promise<boolean>} 端口空闲返回 true；被占用或绑定失败返回 false
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
 * 杀掉占用指定端口的进程
 * [WHY] 端口占用时 kill 掉再启动，避免自动切端口导致 vite proxy 端口错位
 * [CONSTRAINT] Unix 用 lsof -ti；Windows 用 netstat -ano + taskkill；无占用时静默返回 []
 * @param {number} port 端口号
 * @returns {number[]} 被杀的 PID 列表
 */
function killPortOccupant(port) {
  const killed = []
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8' })
      const pids = new Set()
      for (const line of out.split('\n')) {
        const m = line.trim().match(/\s(\d+)\s*$/)
        if (m && m[1] !== '0') pids.add(m[1])
      }
      for (const pid of pids) {
        try { execSync(`taskkill /F /PID ${pid}`); killed.push(Number(pid)) } catch { /* ignore */ }
      }
    } else {
      const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: 'utf8' }).trim()
      if (out) {
        for (const pid of out.split('\n').filter(Boolean)) {
          try { process.kill(Number(pid), 'SIGKILL'); killed.push(Number(pid)) } catch { /* ignore */ }
        }
      }
    }
  } catch { /* 无占用或命令不可用 */ }
  return killed
}

/**
 * 确保端口可用：被占用则 kill 占用进程并等待释放
 * [CONSTRAINT] 上限 MAX_KILL_TRIES 防死循环；占满则抛错由调用方处理
 * @param {number} port 目标端口
 * @returns {Promise<number>} 实际使用的端口（即入参）
 */
async function ensurePortFree(port) {
  for (let i = 0; i < MAX_KILL_TRIES; i++) {
    if (await isPortFree(port)) return port
    const killed = killPortOccupant(port)
    if (killed.length === 0) {
      throw new Error(`端口 ${port} 被占用，但无法定位占用进程（可能权限不足）`)
    }
    console.log(`⚠ 端口 ${port} 被占用，已 kill 进程 PID: ${killed.join(', ')}`)
    // [WHY] kill 后端口未必立即释放，留出 OS 回收窗口再探活
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error(`端口 ${port} 连续 ${MAX_KILL_TRIES} 次 kill 后仍被占用`)
}

async function main() {
  const backendPort = await ensurePortFree(BACKEND_BASE)
  const frontendPort = await ensurePortFree(FRONTEND_BASE)

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
