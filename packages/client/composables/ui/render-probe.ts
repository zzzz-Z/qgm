// [ui-p2c-render-probe-v1] V9 渲染计数探针（dev-only）：
// [WHY] 计划验收判据 ①「500 事件会话下单事件到达重渲染卡数 ≤ 3」需要一个可复现的
//   观测点；靠 DevTools 高亮是人工验收，无法回归。本模块在 DEV 下记录每张卡的
//   mounted/updated 事件，供 e2e 或控制台读取。
// [CONSTRAINT] 生产构建中 enabled() 恒 false，运行时仅剩一次布尔判断；
//   探针只记录、不参与业务逻辑；被记录方组件不应依赖其存在。

/** 单条打点记录 */
export interface ProbeEntry {
  key: string
  phase: 'mount' | 'update'
  ts: number
}

/** 环形缓冲上限，防止长会话撑爆内存 */
const LOG_MAX = 5000

/**
 * 探针开关判定：DEV 且宿主显式打开
 * [CONSTRAINT] 必须同时满足两者，避免 dev 下误开影响正常开发
 */
function enabled(): boolean {
  // [ui-p2c-env-typing-v1] 复用 utils/log.ts 的宽档断言模式：test tsconfig 不含 env.d.ts，
  //   直接访问 import.meta.env 会 TS2339；此写法两种 tsconfig 下都通过。
  if (!(import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) return false
  try {
    if (typeof window === 'undefined') return false
    return Boolean((window as unknown as { __AI_RENDER_PROBE__?: unknown }).__AI_RENDER_PROBE__)
  } catch { return false }
}

let log: ProbeEntry[] = []

/** 记录一次卡片渲染事件；enabled() 为 false 时零成本早退 */
export function probeRender(key: string, phase: 'mount' | 'update'): void {
  if (!enabled()) return
  log.push({ key, phase, ts: Date.now() })
  if (log.length > LOG_MAX) log = log.slice(-LOG_MAX)
}

/** 读取全部打点（快照副本，防外部修改内部状态） */
export function getProbeLog(): ProbeEntry[] {
  return log.slice()
}

/** 清空打点（e2e 用例之间隔离） */
export function clearProbeLog(): void {
  log = []
}

// [CONSTRAINT] 挂到 window 供 Playwright 读取；仅在浏览器环境执行
if (typeof window !== 'undefined') {
  const w = window as unknown as { __AI_RENDER_PROBE_READ__?: { get: typeof getProbeLog, clear: typeof clearProbeLog } }
  w.__AI_RENDER_PROBE_READ__ = { get: getProbeLog, clear: clearProbeLog }
}
