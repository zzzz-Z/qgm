// [discover-targets-v1] 自动发现「本轮 DONE 该验哪些应用」。
//
// [WHY] 原冒烟硬编码 paths=['/', '/__ai/']，只验 AI Runner 自身（5175），
//   业务 dev server（如外部项目的 8091）从未被验 —— 即「验证错目标」那类 bug 的根。
//   人工填 APP_DEV_URL 在多项目下不可维护，故改为**自动发现**：
//     ① 宿主 `/__ai/` 始终作为 [host]（agent 自身底座，不可丢）；
//     ② 端口探测：探活常用 dev 端口（排除宿主 5175-5185），开着且像 dev server 即纳入 [app]；
//     ③ 配置标注：扫项目根的 .env/vite/package，给探测到的端口打「哪个项目」标签；
//     ④ env 覆盖：APP_DEV_URL（逗号分隔多个）作为显式强制项。
//
// [CONSTRAINT] 探测必须快且 fail-open：单端口超时 200ms、并发上限 30；任一环节异常只跳过不阻断。
//   绝不探测宿主 5175-5185 区间（instance-ownership：那归 pm2，碰了会端口漂移）。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import net from 'node:net'
import { getRoot } from '../config.js'

/** 验证目标来源：宿主 / 显式 env / 端口探测 / 配置标注 */
export type TargetSource = 'host' | 'env' | 'portscan' | 'config'

/** 一个待验证目标（host 或业务 app） */
export interface VerifyTarget {
  /** 报告用标签，如 `host` / `app:proj-a` / `app:port-8091` */
  tag: string
  /** 待冒烟的 base URL（不含路径） */
  url: string
  source: TargetSource
  /** 配置标注得到的项目名（端口探测命中配置时填） */
  project?: string
}

/** 常用 dev server 端口（探测白名单；外加配置里解析出的端口） */
export const COMMON_DEV_PORTS = [
  3000,
  3001,
  4000,
  4200,
  5000,
  5173,
  5174,
  5175,
  8000,
  8080,
  8081,
  8090,
  8091,
  8888,
  9000,
  9001,
  30000,
  30001,
]

/** 宿主端口区间：instance-ownership 规定归 pm2，探测必须跳过，否则端口漂移 */
const HOST_PORT_MIN = 5175
const HOST_PORT_MAX = 5185

export function isHostPort(p: number): boolean {
  return p >= HOST_PORT_MIN && p <= HOST_PORT_MAX
}

/**
 * [macos-airplay-5000-v1] 系统保留端口：虽在 COMMON_DEV_PORTS 中，但被 OS 服务常驻占用。
 * [WHY] macOS 的 AirPlay Receiver（ControlCenter）默认监听 5000，探测到它会把
 *   「系统服务」误报为 [app:port-5000]（冒烟持续 403，本仓滚动多轮未决）。
 * [CONSTRAINT] 从探测候选剔除，但不从 COMMON_DEV_PORTS 删除——用户可能真在 5000 跑 Flask
 *   （那时会经配置标注 app:<project> 或 APP_DEV_URL 显式纳入）。
 */
const SYSTEM_RESERVED_PORTS = new Set<number>([5000])

export function isReservedPort(p: number): boolean {
  return SYSTEM_RESERVED_PORTS.has(p)
}

/**
 * 探测单端口是否可连接（TCP 层，不等 HTTP）。
 * @param port 端口
 * @param timeoutMs 超时，默认 200ms
 */
export function probePort(port: number, timeoutMs = 200): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host: '127.0.0.1' }, () => {
      sock.destroy()
      resolve(true)
    })
    sock.setTimeout(timeoutMs)
    sock.on('timeout', () => { sock.destroy(); resolve(false) })
    sock.on('error', () => { sock.destroy(); resolve(false) })
  })
}

/** 有界并发探活端口列表，返回所有「开着」的端口 */
export async function probePorts(ports: number[]): Promise<number[]> {
  const open: number[] = []
  const CONC = 30
  for (let i = 0; i < ports.length; i += CONC) {
    const batch = ports.slice(i, i + CONC)
    const res = await Promise.all(batch.map(p => probePort(p)))
    batch.forEach((p, idx) => { if (res[idx]) open.push(p) })
  }
  return open
}

/** 从 .env* 文本提取 VITE_APP_PORT / PORT */
export function parseEnvPorts(text: string): number[] {
  const out: number[] = []
  const re = /^\s*(?:VITE_APP_PORT|PORT)\s*=\s*(\d+)/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) out.push(Number(m[1]))
  return out
}

/** 从 package.json 的 dev 脚本提取 `--port N` / `-p N` */
export function parsePackagePort(script: string): number | null {
  const m = script.match(/(?:--port|-p)\s+(\d+)/)
  return m ? Number(m[1]) : null
}

/**
 * 扫描项目根 + 其一级子目录，解析各项目的 dev 端口 → 项目名映射。
 * [WHY] 仅取一层子目录（含 vite.config/package.json 的）避免大仓库深递归。
 * [CONSTRAINT] 任何读取失败只跳过该目录，不抛。
 */
export function scanConfigPorts(root: string): Map<number, string> {
  const map = new Map<number, string>()
  const dirs = [root]
  try {
    for (const name of readdirSync(root)) {
      const sub = join(root, name)
      try { if (statSync(sub).isDirectory()) dirs.push(sub) } catch { /* skip */ }
    }
  } catch { /* root 不可读 */ }
  for (const dir of dirs) {
    const project = dir === root ? '<root>' : dir.split('/').pop() || dir
    // .env / .env.development
    for (const f of ['.env', '.env.development', '.env.local']) {
      const p = join(dir, f)
      if (!existsSync(p)) continue
      try { for (const port of parseEnvPorts(readFileSync(p, 'utf8'))) map.set(port, project) }
      catch { /* skip */ }
    }
    // package.json dev script
    const pkg = join(dir, 'package.json')
    if (existsSync(pkg)) {
      try {
        const j = JSON.parse(readFileSync(pkg, 'utf8'))
        const dev = j?.scripts?.dev
        if (typeof dev === 'string') {
          const port = parsePackagePort(dev)
          if (port) map.set(port, project)
        }
      } catch { /* skip */ }
    }
  }
  return map
}

export interface DiscoverOpts {
  /** 宿主 base URL（如 `http://localhost:5175`），作为 [host] 目标 */
  hostUrl?: string
  /** 项目根（默认 getRoot） */
  root?: string
  /** 跳过端口探测（测试用） */
  skipPortScan?: boolean
}

/**
 * 自动发现本轮需验证的目标：宿主 + 显式 env + 端口探测 + 配置标注。
 * 去重按 url；端口探测区间排除宿主 5175-5185。
 */
export async function discoverTargets(opts: DiscoverOpts = {}): Promise<VerifyTarget[]> {
  const root = opts.root ?? getRoot()
  const targets: VerifyTarget[] = []

  // ① 宿主
  if (opts.hostUrl) {
    targets.push({ tag: 'host', url: opts.hostUrl.replace(/\/$/, ''), source: 'host' })
  }

  const byUrl = new Map<string, VerifyTarget>()
  const add = (t: VerifyTarget) => {
    const key = t.url.replace(/\/$/, '')
    if (!byUrl.has(key)) { byUrl.set(key, t); targets.push(t) }
  }

  // ② 显式 env 覆盖（逗号分隔多个）
  const envRaw = process.env.APP_DEV_URL
  if (envRaw) {
    for (const raw of envRaw.split(',').map(s => s.trim()).filter(Boolean)) {
      const url = raw.replace(/\/$/, '')
      if (/^https?:\/\//.test(url)) add({ tag: 'app:env', url, source: 'env' })
    }
  }

  // ③ 配置标注：项目根 → 端口 → 项目名
  let configMap = new Map<number, string>()
  try { configMap = scanConfigPorts(root) } catch { /* skip */ }

  if (!opts.skipPortScan) {
    // ④ 端口探测：常用端口 ∪ 配置端口，排除宿主区间
    const candidates = new Set<number>(COMMON_DEV_PORTS)
    for (const p of configMap.keys()) candidates.add(p)
    const toProbe = [...candidates].filter(p => !isHostPort(p) && !isReservedPort(p))
    let open: number[] = []
    try { open = await probePorts(toProbe) } catch { /* skip */ }
    for (const port of open) {
      const url = `http://127.0.0.1:${port}`
      const project = configMap.get(port)
      if (project) {
        add({ tag: `app:${project}`, url, source: 'config', project })
      } else {
        add({ tag: `app:port-${port}`, url, source: 'portscan' })
      }
    }
  } else if (configMap.size) {
    // 跳过端口探测时，仍把配置端口作为 [app:config] 目标（便于非运行态也能标注）
    for (const [port, project] of configMap) {
      if (isHostPort(port)) continue
      add({ tag: `app:${project}`, url: `http://127.0.0.1:${port}`, source: 'config', project })
    }
  }

  return targets
}
