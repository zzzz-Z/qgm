import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { getScopeRoot } from './workspace-scope.js'

// pkg-structure

// eslint-disable-next-line import/no-mutable-exports -- 可变绑定：setRoot 会改写
export let ROOT = process.cwd()

/**
 * 是否已绑定工作区
 * [WHY] 生产环境（standalone）默认无工作区，用户须显式选择；开发环境（vite-plugin）启动时自动绑定 process.cwd()
 * [CONSTRAINT] 与 ROOT 解耦：无工作区时 ROOT 仍保持 process.cwd()，避免 join('', ...) 静默退化为相对路径
 * [CHANGE-IMPACT] 路由层需消费本标志实现"无工作区"拒绝策略；下游 60+ getRoot() 消费点行为不变
 */
// eslint-disable-next-line import/no-mutable-exports -- 可变绑定：setRoot / clearWorkspace 会改写
export let hasWorkspace = false

// eslint-disable-next-line import/no-mutable-exports -- ESM live bindings, setRoot 内重新赋值
export let SCRIPTS_DIR = path.join(ROOT, '.ai-runner/scripts')

/**
 * 设置项目根目录并同步派生目录常量
 * [WHY] strip-types 环境下部分模块无法 import config，靠 env.AI_RUNNER_ROOT 传值；此处写 env 作权威源
 * [CONSTRAINT] 会同时重算 SCRIPTS_DIR；ESM live binding 让已 import 方读到新值
 * [CHANGE-IMPACT] 影响所有依赖派生目录的模块（snapshot / timeline / run 等）；应在启动早期调用一次
 * @param rootPath 项目根目录；会被规范化为绝对路径
 */
export function setRoot(rootPath: string): void {
  ROOT = path.resolve(rootPath)
  // 写 env，供 strip-types 无法 import 的模块读
  process.env.AI_RUNNER_ROOT = ROOT
  // [has-workspace-v1] setRoot 即视为"已选择工作区"；与 clearWorkspace 成对
  hasWorkspace = true
  // ESM live bindings：import 方在 setRoot 后读到的是新值
  SCRIPTS_DIR = path.join(ROOT, '.ai-runner/scripts')
}
/**
 * 获取 Root
 * [multi-workspace-v1] 作用域化：/run 在 runWithWorkspace 内执行时解析为该请求的工作区 root，
 *   否则回落活跃 ROOT——103 处既有调用点零改动即获得按请求隔离（并发运行不串台）
 */
export function getRoot(): string {
  return getScopeRoot(ROOT)
}

/**
 * 清除工作区绑定（回到"未选择"状态）
 * [WHY] 用户主动退出工作区或生产环境启动时复位；与 setRoot 成对
 * [CONSTRAINT] 不重置 ROOT / process.env.AI_RUNNER_ROOT：保持 cwd 与旧 env 供下游 fallback，仅翻转 hasWorkspace
 * [CHANGE-IMPACT] 路由层随即拒绝所有工作区相关请求；再次 setRoot 即恢复
 */
export function clearWorkspace(): void {
  hasWorkspace = false
}

/**
 * 读取当前工作区绑定状态
 * [WHY] 路由层守卫需在请求入口判定"是否已选工作区"，避免每个消费者都 import 可变绑定
 * [CONSTRAINT] 与 hasWorkspace ESM live binding 语义一致
 */
export function getHasWorkspace(): boolean {
  return hasWorkspace
}

/**
 * 用户级工作区配置目录（持久化位置）
 * [WHY] 生产环境重启后需恢复用户选择的工作区；存 home 而非工作区自身，避免"没工作区时无处存"的鸡生蛋问题
 * [CONSTRAINT] 依赖 os.homedir()；SSR / 无 HOME 环境回落空串由各函数 try/catch 兜底
 */
const WORKSPACE_CONF_DIR = process.env.AI_RUNNER_WORKSPACE_CONF_DIR || path.join(os.homedir(), '.ai-runner')
/** 工作区配置文件绝对路径 */
const WORKSPACE_CONF_FILE = path.join(WORKSPACE_CONF_DIR, 'workspace.json')

/** 注册表（内存权威态，落盘经 persistWorkspace） */
const workspaces = new Map<string, WorkspaceEntry>()

/**
 * [workspace-session-bind-v1] 工作区 → DeepSeek 会话绑定（单窗口切换地址的数据源）。
 * [WHY] 切工作区时需要把受控 DeepSeek 窗口导航到该工作区对应的会话；无绑定时才新建。
 * [CONSTRAINT] sessionId 允许空串（新建但尚未回写）；url 是导航目标，两者都存便于回写识别。
 */
export interface WorkspaceSession {
  url: string
  sessionId: string
  updatedAt: number
}
/** [workspace-schema-v2] 内联会话绑定：homeUrl（站点首页）/ sessionUrl（具体会话）分离，消灭「首页冒充会话 URL」 */
export interface WorkspaceSessionInline {
  homeUrl: string
  sessionUrl: string
  sessionId: string
  updatedAt: number
}
// [workspace-schema-v2] 会话绑定内联到 entry.session；顶层 Map 已删除
// [first-prompt-persist-v1] 首问标记的键为复合键 `<wsId>::<modelId>`，不是裸 wsId。
// [WHY] 用户要求：切工作区不该重发 SYSTEM.md（会话上下文没变）；同时「每个 AI 服务商的首问状态要隔离」。
//   原实现键只有 wsId → 同一工作区切服务商后 wsSent 仍为 true，硬短路 → 新站点永不注入 SYSTEM.md。
//   复合键后：切工作区读同一份（同站点）状态不重发；切到不同服务商读独立键，该发就发。
// [CONSTRAINT] 旧版裸 wsId 键在加载时被丢弃（升级一次性重注入属预期代价，避免把「DeepSeek 已发」误当
//   「千问也已发」）；持久化形态仍是 Record<string, boolean>，字段名不变，旧文件向后兼容读。
// [workspace-schema-v2] 首问标记内联到 entry.firstPromptSent?.[modelId]；顶层 Map 已删除
// [workspace-schema-v2] firstPromptKey 退役：复合键仅存在于派生的顶层对象里
// eslint-disable-next-line import/no-mutable-exports -- 可变绑定：activateWorkspace 会改写（与 ROOT 同理）
export let activeWorkspaceId: string | null = null

/**
 * 持久化当前工作区（用户选择成功后调用）
 * [WHY] 跨进程重启恢复用户选择；不持久化则每次启动都要重选
 * [CONSTRAINT] 目录不存在自动创建；写入失败静默（配额 / 只读 fs 场景不阻断主流程）
 * [CHANGE-IMPACT] 与 loadWorkspaceRegistry 严格配对；键名 root 变更会导致旧配置读取失败
 */
export function persistWorkspace(): void {
  try {
    fs.mkdirSync(WORKSPACE_CONF_DIR, { recursive: true })
    // [workspace-schema-v2][D3] 顶层 sessions / firstPromptSent 已删除：
    //   恢复循环（loadWorkspaceRegistry）已携带内联字段，并经一个完整重启周期验证；
    //   旧读方所需的派生键不再写出。**读侧仍兼容**：迁移分支照旧从旧文件的顶层键迁移。
    const body = JSON.stringify({
      schemaVersion: 2,
      root: ROOT,
      at: Date.now(),
      workspaces: [...workspaces.values()],
      activeId: activeWorkspaceId,
    })
    // [workspace-atomic-write-v1] 先写 .tmp 再 rename：迁移整文件重写中途崩溃不留半截文件
    const tmp = `${WORKSPACE_CONF_FILE}.tmp`
    try {
      fs.writeFileSync(tmp, body)
      fs.renameSync(tmp, WORKSPACE_CONF_FILE)
    } catch {
      try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
      fs.writeFileSync(WORKSPACE_CONF_FILE, body)
    }
  } catch { /* ignore: 持久化失败不阻断主流程 */ }
}

/**
 * 清除持久化的工作区配置
 * [WHY] 用户主动退出工作区或配置损坏时复位；不清则下次启动会误恢复
 * [CONSTRAINT] 文件不存在时静默（force: true）；与 persistWorkspace 配对
 */
export function clearPersistedWorkspace(): void {
  try { fs.rmSync(WORKSPACE_CONF_FILE, { force: true }) } catch { /* ignore */ }
}

// [multi-workspace-v1] 多工作区注册表：多份代码树并存，同一时刻恰一个是活跃工作区。
// [WHY] 阶段 1（只读多工作区）：注册表只是「单工作区切换」之上的簿记层——activate 落到既有
//   setRoot 原语，103 处 getRoot() 消费点语义不变；阶段 2 的按 id 并行执行由 workspace-scope 承担。
// [CONSTRAINT] id 由解析后路径确定性派生（同路径重复注册幂等）；移除活跃工作区被拒绝（避免悬空 activeId）。

/** 注册表条目：确定性 id、root 绝对路径、展示名、入库时刻；[workspace-schema-v2] 内联关联数据 */
export interface WorkspaceEntry {
  id: string
  root: string
  label: string
  addedAt: number
  /** [workspace-schema-v2] 内联会话绑定（homeUrl/sessionUrl 分离） */
  session?: WorkspaceSessionInline
  /** [workspace-schema-v2] 内联首问标记（按 modelId 维度） */
  firstPromptSent?: Record<string, boolean>
}

/** 由 root 绝对路径派生确定性工作区 id（同路径幂等） */
function workspaceIdFor(root: string): string {
  return createHash('sha1').update(root).digest('hex').slice(0, 12)
}

/**
 * 注册工作区（幂等）：路径规范化后按 id 去重；已存在则原样返回。
 * [CHANGE-IMPACT] /workspace/select、/workspace/pick 也会调用本函数——旧入口切换即自动入册
 * @param root 工作区根目录绝对路径（须已存在且为目录，由调用方校验）
 * @param activate 注册后是否立即激活（首个注册默认激活）
 */
export function registerWorkspace(root: string, activate?: boolean): WorkspaceEntry {
  const resolved = path.resolve(root)
  const id = workspaceIdFor(resolved)
  let entry = workspaces.get(id)
  if (!entry) {
    entry = { id, root: resolved, label: path.basename(resolved) || resolved, addedAt: Date.now() }
    workspaces.set(id, entry)
  }
  if (activate || !activeWorkspaceId) activateWorkspace(id)
  else persistWorkspace()
  return entry
}

/**
 * 移除工作区。
 * [workspace-remove-active-v1] 允许移除活跃工作区：自动切到剩余项中最早入册的一个，
 *   若已无剩余项则清空（setRoot("") → hasWorkspace=false → UI 回引导页）。
 * [WHY] 原「活跃不可移除」会让用户点 × 无反应（toast 提示需先切），与「每个 tab 都能删除」冲突。
 * [CONSTRAINT] 回退顺序按 addedAt 升序（与注册表 getWorkspaces 一致）；无剩余项时调 clearWorkspace。
 * @returns ok=false 时 reason 说明原因
 */
export function removeWorkspace(id: string): { ok: boolean, reason?: string } {
  if (!workspaces.has(id)) return { ok: false, reason: `工作区不存在：${id}` }
  const wasActive = id === activeWorkspaceId
  // [workspace-schema-v2] 关联数据内联在条目上，delete 即全部消失（不再需要手工清 Map）
  workspaces.delete(id)
  if (wasActive) {
    const remaining = [...workspaces.values()].sort((a, b) => a.addedAt - b.addedAt)
    const next = remaining[0]
    if (next) {
      activeWorkspaceId = next.id
      setRoot(next.root)
    } else {
      activeWorkspaceId = null
      clearWorkspace()
      clearPersistedWorkspace()
    }
  }
  persistWorkspace()
  return { ok: true }
}

/**
 * 激活工作区：落到既有 setRoot 原语（hasWorkspace 置位、SCRIPTS_DIR 重算、env 写权威源），
 * 这正是「注册表是簿记层，切换语义不变」的实现点。
 */
export function activateWorkspace(id: string): { ok: boolean, reason?: string } {
  const entry = workspaces.get(id)
  if (!entry) return { ok: false, reason: `工作区不存在：${id}` }
  activeWorkspaceId = id
  setRoot(entry.root)
  persistWorkspace()
  return { ok: true }
}

/** 按 id 查注册表条目；不存在返回 null */
export function getWorkspace(id: string): WorkspaceEntry | null {
  return workspaces.get(id) ?? null
}

/** 注册表快照（按入库时间升序） */
export function getWorkspaces(): WorkspaceEntry[] {
  return [...workspaces.values()].sort((a, b) => a.addedAt - b.addedAt)
}

/**
 * [workspace-session-bind-v1] 读某工作区的会话绑定；无绑定返回 null。
 * [CONSTRAINT] 只读，不触发持久化；调用方按需决定是否回退到「新建会话」。
 */
export function getWorkspaceSession(id: string): WorkspaceSession | null {
  // [workspace-schema-v2] 条目为权威：派生旧形状 url = sessionUrl || homeUrl，routes 与既有测试零改动
  const s = workspaces.get(id)?.session
  if (!s) return null
  return { url: s.sessionUrl || s.homeUrl, sessionId: s.sessionId, updatedAt: s.updatedAt }
}

/**
 * [workspace-session-bind-v1] 写某工作区的会话绑定（幂等覆盖）。
 * [CONSTRAINT] 只接受已注册的工作区 id（防止脏键累积）；写入后立即持久化。
 * @returns 工作区不存在时返回 false，调用方据此提示
 */
export function setWorkspaceSession(
  id: string,
  session: { url?: string, sessionId?: string, kind?: 'site' | 'session', homeUrl?: string, sessionUrl?: string },
): boolean {
  const entry = workspaces.get(id)
  if (!entry) return false
  // [workspace-schema-v2] kind 缺省推断：sessionId 非空 → session，否则 → site（兼容旧两参调用）
  const kind = session.kind || (String(session.sessionId || '') ? 'session' : 'site')
  const prev = entry.session
  const now = Date.now()
  if (kind === 'site') {
    const homeUrl = String(session.homeUrl ?? session.url ?? '')
    entry.session = { homeUrl, sessionUrl: '', sessionId: '', updatedAt: now }
  } else {
    const sessionUrl = String(session.sessionUrl ?? session.url ?? '')
    entry.session = {
      homeUrl: String(session.homeUrl ?? prev?.homeUrl ?? ''),
      sessionUrl,
      sessionId: String(session.sessionId || ''),
      updatedAt: now,
    }
  }
  persistWorkspace()
  return true
}

/**
 * [workspace-session-bind-v1] 会话绑定全量快照（端点 GET 用）。
 */
export function getWorkspaceSessions(): Record<string, WorkspaceSession> {
  // [workspace-schema-v2] 仅含有 session 的条目；url 派生规则与 getWorkspaceSession 一致
  const out: Record<string, WorkspaceSession> = {}
  for (const e of workspaces.values()) {
    if (!e.session) continue
    out[e.id] = { url: e.session.sessionUrl || e.session.homeUrl, sessionId: e.session.sessionId, updatedAt: e.session.updatedAt }
  }
  return out
}

/**
 * [first-prompt-persist-v1] 读某工作区 + 服务商的「首问是否已带过规则头」。
 * [CONSTRAINT] 未记录 / 工作区不存在一律视为 false（= 该发规则）。
 * @param id 工作区 id
 * @param modelId 站点 modelId（如 'deepseek'/'qianwen'）；缺省时退化为裸 wsId 键（测试兜底）
 */
export function getWorkspaceFirstPromptSent(id: string, modelId?: string): boolean {
  const m = String(modelId || '').trim()
  if (!m) return false
  return workspaces.get(id)?.firstPromptSent?.[m] === true
}

/**
 * [first-prompt-persist-v1] 写某工作区 + 服务商的首问状态（幂等覆盖）。
 * [CONSTRAINT] 只接受已注册的工作区 id（防脏键）；写入后立即持久化。
 * @param id 工作区 id
 * @param modelId 站点 modelId；缺省时退化为裸 wsId 键
 * @param sent 是否已发过首问
 * @returns 工作区不存在时返回 false
 */
export function setWorkspaceFirstPromptSent(id: string, modelId: string | undefined, sent: boolean): boolean {
  const entry = workspaces.get(id)
  if (!entry) return false
  const m = String(modelId || '').trim()
  if (!m) return false
  const prev = entry.firstPromptSent?.[m] === true
  const next = Boolean(sent)
  // [workspace-write-skip-v1] 值未变时不落盘：newSession 分支每次切换都会调本函数
  if (prev === next) return true
  if (next) {
    entry.firstPromptSent = { ...(entry.firstPromptSent || {}), [m]: true }
  } else if (entry.firstPromptSent) {
    delete entry.firstPromptSent[m]
  }
  persistWorkspace()
  return true
}

/** 当前活跃工作区 id；null = 未激活 */
export function getActiveWorkspaceId(): string | null {
  return activeWorkspaceId
}

/**
 * [workspace-schema-v2] v1 → v2 迁移：把顶层 sessions / firstPromptSent 并入条目内联字段。
 * [WHY] 旧文件把关联数据放在顶层键、条目上没有内联字段；不迁移则 v2 读路径取不到任何绑定。
 * [CONSTRAINT] 键匹配一律用 workspaceIdFor(path.resolve(root)) **重算**——写入侧（setWorkspaceSession）
 *   用的就是调用方传入的 id，而恢复侧历史上也是重算；用条目自带 id 匹配会丢掉全部绑定（P3）。
 *   脏键（归属不到任何条目）丢弃并 warn 一条，不静默吞掉。
 * @returns 是否发生了实际迁移（决定是否立即落盘）
 */
function migrateV1ToV2(j: {
  sessions?: Record<string, { url?: string, sessionId?: string, updatedAt?: number }>
  firstPromptSent?: Record<string, boolean>
}): boolean {
  let touched = false
  const byId = new Map<string, WorkspaceEntry>()
  for (const e of workspaces.values()) byId.set(e.id, e)
  // ① sessions → entry.session
  for (const [wid, s] of Object.entries(j.sessions || {})) {
    const e = byId.get(wid)
    if (!e) { console.warn(`[workspace-migrate] 顶层 sessions 键无对应工作区，已丢弃：${wid}`); continue }
    if (!s || typeof s.url !== 'string') continue
    if (e.session) continue
    const url = s.url
    const sid = String(s.sessionId || '')
    // 站点根判定不依赖 MODELS：URL 路径为 '/' 即视为首页
    let pathname = '/'
    try { pathname = new URL(url).pathname || '/' } catch { pathname = '/' }
    if (sid) e.session = { homeUrl: '', sessionUrl: url, sessionId: sid, updatedAt: Number(s.updatedAt) || 0 }
    else if (pathname === '/') e.session = { homeUrl: url, sessionUrl: '', sessionId: '', updatedAt: Number(s.updatedAt) || 0 }
    else e.session = { homeUrl: '', sessionUrl: url, sessionId: '', updatedAt: Number(s.updatedAt) || 0 }
    touched = true
  }
  // ② firstPromptSent（复合键 wsId::modelId）→ entry.firstPromptSent[modelId]
  for (const [k, v] of Object.entries(j.firstPromptSent || {})) {
    if (v !== true) continue
    const at = k.indexOf('::')
    if (at <= 0) { console.warn(`[workspace-migrate] 非复合键首问标记已丢弃：${k}`); continue }
    const wid = k.slice(0, at)
    const model = k.slice(at + 2)
    const e = byId.get(wid)
    if (!e) { console.warn(`[workspace-migrate] 首问标记键无对应工作区，已丢弃：${k}`); continue }
    if (!model) continue
    if (e.firstPromptSent?.[model] === true) continue
    e.firstPromptSent = { ...(e.firstPromptSent || {}), [model]: true }
    touched = true
  }
  return touched
}

/**
 * 启动时从 workspace.json 恢复注册表并激活活跃项。
 * [WHY] standalone 启动唯一合法入口（替代直接调 loadPersistedWorkspace）；
 *   旧格式（仅 {root}）自动迁移为单条注册并激活，用户无感升级。
 * [CONSTRAINT] 恢复前不清 Map（幂等可重复调用）；磁盘缺失/损坏按「无注册」处理返回 null
 * @returns 恢复并激活的 root；无可恢复项返回 null
 */
export function loadWorkspaceRegistry(): string | null {
  try {
    const raw = fs.readFileSync(WORKSPACE_CONF_FILE, 'utf8')
    const j = JSON.parse(raw) as {
      schemaVersion?: number
      root?: string
      workspaces?: WorkspaceEntry[]
      sessions?: Record<string, { url?: string, sessionId?: string, updatedAt?: number }>
      firstPromptSent?: Record<string, boolean>
    }
    const list = Array.isArray(j.workspaces) ? j.workspaces : []
    // [workspace-schema-v2] 恢复循环**携带内联字段**（Q1 修复核心）：
    //   重建条目时若不解构 session / firstPromptSent，重启即把内联数据剥掉，
    //   一切「条目为权威」都成幻觉（v2 计划在此自相矛盾）。
    for (const e of list) {
      if (!e || typeof e.root !== 'string' || !fs.existsSync(e.root) || !fs.statSync(e.root).isDirectory()) continue
      const id = workspaceIdFor(path.resolve(e.root))
      if (workspaces.has(id)) continue
      const entry: WorkspaceEntry = {
        id,
        root: path.resolve(e.root),
        label: String(e.label || path.basename(e.root) || e.root),
        addedAt: Number(e.addedAt) || Date.now(),
      }
      const s = e.session
      if (s && typeof s.homeUrl === 'string' && typeof s.sessionUrl === 'string' && typeof s.sessionId === 'string') {
        entry.session = { homeUrl: s.homeUrl, sessionUrl: s.sessionUrl, sessionId: s.sessionId, updatedAt: Number(s.updatedAt) || 0 }
      }
      const fp = e.firstPromptSent
      if (fp && typeof fp === 'object') {
        const keep: Record<string, boolean> = {}
        for (const [m, v] of Object.entries(fp)) { if (v === true) keep[m] = true }
        if (Object.keys(keep).length) entry.firstPromptSent = keep
      }
      workspaces.set(id, entry)
    }
    // [workspace-schema-v2] v1 → v2 迁移：旧文件把关联数据放在顶层键，且条目上没有内联字段。
    // [CONSTRAINT] 旧格式分支（workspaces 空 + j.root）在其后仍走 registerWorkspace，二者不互斥。
    if (j.schemaVersion !== 2) {
      const migrated = migrateV1ToV2(j)
      if (migrated) persistWorkspace()
    }
    // 旧格式迁移：只有 root 没有 workspaces 数组
    if (workspaces.size === 0 && j.root && fs.existsSync(j.root) && fs.statSync(j.root).isDirectory()) {
      registerWorkspace(j.root)
    }
    const target = (typeof j === 'object' && j && 'activeId' in j && typeof (j as { activeId?: unknown }).activeId === 'string')
      ? String((j as { activeId: string }).activeId)
      : ''
    const act = target && workspaces.has(target) ? target : [...workspaces.keys()][0]
    if (act) {
      activeWorkspaceId = act
      setRoot(workspaces.get(act)!.root)
      return workspaces.get(act)!.root
    }
    return null
  } catch { return null }
}
/** 项目识别前缀，用于日志与缓存命名空间 */
export const PREFIX = '/__ai'

/** 遍历项目时跳过的目录（依赖、构建产物、版本控制等） */
export const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', '.vite', '.turbo', '.cache'])
/** 遍历时跳过的路径前缀（隐藏目录等） */
export const EXCLUDE_PREFIX = ['.ai-runner']
/** 判定二进制文件的扩展名集合（跳过内容读取） */
export const BINARY_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.svg',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp3',
  '.mp4',
  '.webm',
  '.zip',
  '.gz',
  '.tar',
  '.pdf',
  '.xls',
  '.xlsx',
  '.doc',
  '.docx',
])

/** 文件变更类型：新增 / 修改 / 删除 */
export type ChangeType = 'added' | 'modified' | 'deleted'

/** 单个文件变更记录：类型、路径、差异内容 */
export interface Change {
  path: string
  type: ChangeType
  afterLines?: number
}

/** 一轮运行产出的变更清单（文件 + 统计） */
export interface Manifest {
  changes: Change[]
  createdAt: number
  /**
   * [git-first-rollback-v1] 运行前状态的固化 ref（`refs/ai-runner/pre/<runId>`）。
   * 存在时 `.before` 刻意不落盘——内容已由该 ref 覆盖，回滚走 `git restore --source`；
   * 缺失（非 git 仓库 / 快照失败）则回落 `.before` 内容副本。
   */
  gitRef?: string
}

/** 单次脚本运行的日志条目（时间、退出码、变更数） */
export interface RunLogEntry {
  ts: number
  runId: string
  desc?: string
  why?: string
  script: string
  exit: number
  // [run-timeout-visible-v1] 超时被杀（code=-1/143）与真失败可区分；判断「是否需重试」看它
  timedOut?: boolean
  durationMs: number
  changeCount: number
  changes: Change[]
  errorFiles: string[]
  fingerprints?: Array<{ file: string, line: number, symbol: string, kind: string }>
}
