// [multi-workspace-v1] 工作区注册表客户端状态：GET /workspace/registry 列表 + activate/register/remove。
// [WHY] 左栏从「站点列表」改为「工作区列表」（阶段 1）；激活走服务端 setRoot，随 window.location.reload()
//   与 WorkspaceGuide 同一刷新约定（App.vue 启动期读取 /workspace 决定引导页）。
// [CONSTRAINT] 模块级单例状态（与 useAiWindowTable 同范式）；load() 静默失败——
//   服务端不可达时面板显示空态而非抛未处理 rejection（承重测试在 happy-dom 下无后端）。

/** 注册表条目（与 core 的 WorkspaceEntry 同构） */
export interface WorkspaceItem {
  id: string
  root: string
  label: string
  addedAt: number
}

const workspaces = ref<WorkspaceItem[]>([])
const activeId = ref<string | null>(null)
const loading = ref(false)

/**
 * [workspace-switch-marker-v1] 切工作区必须写标记，让 reload 后的 App 走「切项目」分支（resetSession + 开新会话）。
 * [WHY] 无标记时 App.vue onMounted 的 restoreFromStorage 会把上一个工作区的 sessionId 与消息恢复回来，
 *   叠加新 root 的 SYSTEM.md 首问 → 出现「会话错乱」（用户报告）。
 * [CONSTRAINT] 时间戳必须与 useAppStartup.maybeScheduleReopen 的 15s 窗口一致；写入失败静默降级。
 */
function markSwitchProject(): void {
  try {
    sessionStorage.setItem('__ai_switch_project', '1')
    sessionStorage.setItem('__ai_switch_project_at', String(Date.now()))
  } catch { /* sessionStorage 不可用时退化为普通 reload */ }
}

/** 拉取注册表；失败静默（保留现值） */
async function load(): Promise<void> {
  loading.value = true
  try {
    const r = await fetch('/__ai/workspace/registry')
    if (!r.ok) return
    const j = await r.json().catch(() => null) as { workspaces?: WorkspaceItem[], activeId?: string | null } | null
    if (!j) return
    workspaces.value = Array.isArray(j.workspaces) ? j.workspaces : []
    activeId.value = j.activeId ?? null
  } catch { /* 服务端不可达：面板空态 */ }
  finally { loading.value = false }
}

/** 激活工作区：服务端 setRoot 后整页刷新（切 root 即切会话上下文，与引导页同约定） */
async function activate(id: string): Promise<{ ok: boolean, error?: string }> {
  try {
    const r = await fetch('/__ai/workspace/activate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
    const j = await r.json().catch(() => null) as { ok?: boolean, error?: string } | null
    if (r.ok && j?.ok) { markSwitchProject(); window.location.reload(); return { ok: true } }
    return { ok: false, error: j?.error || `HTTP ${r.status}` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 入册已有目录；activate=true 时同时激活并刷新 */
async function register(path: string, activate = false): Promise<{ ok: boolean, error?: string }> {
  try {
    const r = await fetch('/__ai/workspace/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, activate }) })
    const j = await r.json().catch(() => null) as { ok?: boolean, error?: string } | null
    if (r.ok && j?.ok) {
      if (activate) { markSwitchProject(); window.location.reload(); return { ok: true } }
      await load()
      return { ok: true }
    }
    return { ok: false, error: j?.error || `HTTP ${r.status}` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 出册（活跃工作区服务端拒移 409） */
async function remove(id: string): Promise<{ ok: boolean, error?: string }> {
  try {
    const r = await fetch('/__ai/workspace/remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
    const j = await r.json().catch(() => null) as { ok?: boolean, error?: string } | null
    if (r.ok && j?.ok) { await load(); return { ok: true } }
    return { ok: false, error: j?.error || `HTTP ${r.status}` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** [multi-workspace-create-v1] 新建工作区：worktree（同仓库新分支）/ clone（独立仓库） */
async function create(opts: {
  mode: 'worktree' | 'clone'
  path: string
  branch?: string
  url?: string
  baseRepo?: string
  activate?: boolean
}): Promise<{ ok: boolean, error?: string }> {
  try {
    const r = await fetch('/__ai/workspace/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(opts) })
    const j = await r.json().catch(() => null) as { ok?: boolean, error?: string } | null
    if (r.ok && j?.ok) {
      if (opts.activate) { markSwitchProject(); window.location.reload(); return { ok: true } }
      await load()
      return { ok: true }
    }
    return { ok: false, error: j?.error || `HTTP ${r.status}` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * [trae-new-workspace-v1] 只调系统文件选择器返回路径，不入册不激活。
 * [WHY] 新建工作区要「选基仓库」而非「切工作区」；原 activate/register(activate) 会立即 setRoot + reload，
 *   与「新建」语义冲突（用户报告：想新建结果当前工作区被切走）。
 * [CONSTRAINT] 204 = 用户取消；501 = 平台不支持系统选择器。
 */
async function pickPath(): Promise<{ ok: boolean, path?: string, canceled?: boolean, unsupported?: boolean, error?: string }> {
  try {
    const r = await fetch('/__ai/workspace/pick-path', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    if (r.status === 204) return { ok: false, canceled: true }
    const j = await r.json().catch(() => null) as { ok?: boolean, path?: string, error?: string, unsupported?: boolean } | null
    if (r.ok && j?.ok && j.path) return { ok: true, path: j.path }
    return { ok: false, error: j?.error || `HTTP ${r.status}`, unsupported: Boolean(j?.unsupported) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * [trae-new-workspace-v1] 列出指定 git 工作副本的本地分支。
 * [CONSTRAINT] 服务端 /git/branches 走 `git -C <path>`，非 git 目录会落 reason；调用方据此提示。
 */
async function listBranches(repoPath: string): Promise<{ ok: boolean, current?: string, list?: string[], error?: string }> {
  const p = String(repoPath || '').trim()
  if (!p) return { ok: false, error: '路径为空' }
  try {
    const r = await fetch(`/__ai/git/branches?path=${encodeURIComponent(p)}`, { cache: 'no-store' })
    const j = await r.json().catch(() => null) as { ok?: boolean, current?: string, list?: string[], reason?: string } | null
    if (r.ok && j?.ok) return { ok: true, current: j.current || '', list: Array.isArray(j.list) ? j.list : [] }
    return { ok: false, error: j?.reason || `HTTP ${r.status}` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 工作区注册表组合式（模块级共享状态） */
export function useWorkspaces() {
  return { workspaces, activeId, loading, load, activate, register, remove, create, pickPath, listBranches }
}
