// [multi-workspace-v1] 工作区注册表客户端状态：GET /workspace/registry 列表 + activate/register/remove。
// [workspace-switch-inplace-v1] 激活走服务端 setRoot，前端**原地**刷新本地状态（不整页 reload）——
//   原 reload 会在启动期触发 openAiSession 自动开新 AI 站点窗口，与「切换不打开新窗口」冲突。
// [CONSTRAINT] 模块级单例状态（与 useAiWindowTable 同范式）；load() 静默失败——
//   服务端不可达时面板显示空态而非抛未处理 rejection（承重测试在 happy-dom 下无后端）。

import { ref } from 'vue'

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

// [workspace-epoch-v1] 执行 root 变更计数：切/建/删工作区后**只有本模块知道** root 变了，
//   而 SidePane 用 v-show 保活（不卸载 ⇒ 不含 onMounted），FileTree/WorklogPane 等面板
//   此前只在挂载时拉一次数据 ⇒ 切工作区后仍显示旧 root（或空态）的内容（用户报告：
//   新建工作区后右侧 sidebar 数据没更新）。原先靠整页 reload 重建组件树掩盖了这个缺口。
// [CONSTRAINT] 只在**真正改变 root** 的分支自增；纯 load() 不改 root，不得自增。
const workspaceEpoch = ref(0)

/** 标记执行 root 已变更（供依赖 root 的面板 watch 后重拉） */
function bumpWorkspaceEpoch(): void {
  workspaceEpoch.value += 1
}

/**
 * [workspace-switch-inplace-v1] 切工作区不再整页 reload：原地清会话上下文 + 刷新本地注册表。
 * [WHY] reload 会在启动期触发 useAppStartup.maybeScheduleReopen → openAiSession 自动开新 AI 站点窗口，
 *   与「切换不打开新窗口」的诉求冲突（用户报告）。改为原地切换后，副作用只剩「清空当前会话」——
 *   这正是切 root 的语义：新 root 的 SYSTEM.md 首问不应与旧会话消息混在一起。
 * [CONSTRAINT] 清上下文失败必须静默降级（模块未就绪 / sessionStorage 不可用），不得阻断切换。
 */
async function resetSessionContext(): Promise<void> {
  try {
    const { useSessionManager } = await import('../ai/useSessionManager')
    useSessionManager().resetSession()
  } catch { /* 未就绪：忽略 */ }
  try {
    const { clearEvents } = await import('../ui/useEventStream')
    clearEvents()
  } catch { /* 未就绪：忽略 */ }
  try {
    const { clearInbox } = await import('../runner/useScriptInbox')
    clearInbox()
  } catch { /* 未就绪：忽略 */ }
}

/**
 * [multi-site-parallel-v1] 由窗口槽位 sid 反查所属工作区。
 * [WHY] 回写链路只知 frame 的 sid；若用 activeId 会写错工作区（并行时 A 的回写落进 B）。
 * [CONSTRAINT] 遍历服务端 sessions，用 sidForUrl 比对 URL host；未命中返回 null（调用方回退 activeId）。
 */
async function findWorkspaceBySid(sid: string): Promise<string | null> {
  if (!sid) return null
  try {
    const r = await fetch('/__ai/workspace/session')
    if (!r.ok) return null
    const j = await r.json().catch(() => null) as { sessions?: Record<string, { url?: string }> } | null
    const sessions = j?.sessions || {}
    const { sidForUrl } = await import('../ai/useAiSite')
    for (const [wid, s] of Object.entries(sessions)) {
      if (s && typeof s.url === 'string' && sidForUrl(s.url) === sid) return wid
    }
    return null
  } catch { return null }
}

/**
 * [workspace-session-bind-v1] 读某工作区的 DeepSeek 会话绑定；无则返回 null。
 * [CONSTRAINT] 服务端不可达 / 无绑定一律返回 null，由调用方决定「新建会话」。
 */
async function getSession(id: string): Promise<{ url: string, sessionId: string } | null> {
  try {
    const r = await fetch('/__ai/workspace/session')
    if (!r.ok) return null
    const j = await r.json().catch(() => null) as { ok?: boolean, sessions?: Record<string, { url?: string, sessionId?: string }> } | null
    const s = j?.sessions?.[id]
    if (!s || typeof s.url !== 'string' || !s.url) return null
    return { url: s.url, sessionId: String(s.sessionId || '') }
  } catch { return null }
}

/**
 * [workspace-session-bind-v1] 写某工作区的 DeepSeek 会话绑定。
 * [CONSTRAINT] 失败静默（不阻断切换）；由回写链路（useAiReplyHandlers）主动调用。
 */
async function setSession(id: string, session: { url: string, sessionId: string }): Promise<boolean> {
  try {
    const r = await fetch('/__ai/workspace/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, ...session }) })
    return r.ok
  } catch { return false }
}

/**
 * [first-prompt-persist-v1] 读某工作区是否已发过带规则首问。
 * [CONSTRAINT] 服务端不可达 / 未记录一律返回 false（保守：视为该发规则）。
 */
async function getFirstPromptSent(id: string, modelId?: string): Promise<boolean> {
  try {
    // [key-composite-v1] 首问标记按 (工作区, 服务商) 复合维度：切服务商读独立键，避免跨站串状态
    const q = `id=${encodeURIComponent(id)}${modelId ? `&model=${encodeURIComponent(modelId)}` : ''}`
    const r = await fetch(`/__ai/workspace/first-prompt?${q}`)
    if (!r.ok) return false
    const j = await r.json().catch(() => null) as { ok?: boolean, sent?: boolean } | null
    return j?.sent === true
  } catch { return false }
}

/**
 * [first-prompt-persist-v1] 写某工作区首问状态。
 * [CONSTRAINT] 失败静默（不阻断 copyAndFill）；服务端会在工作区不存在时返回 404。
 */
async function setFirstPromptSent(id: string, modelId: string | undefined, sent: boolean): Promise<boolean> {
  try {
    const r = await fetch('/__ai/workspace/first-prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, model: modelId || '', sent }) })
    return r.ok
  } catch { return false }
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

/**
 * [workspace-switch-inplace-v1] 激活工作区：服务端 setRoot 后**原地**更新本地状态（不整页 reload）。
 * [WHY] 原实现 `markSwitchProject + window.location.reload` 会在启动期触发 openAiSession 自动开新窗口，
 *   与「切换时不打开新窗口」冲突；改为本地更新 activeId + 清会话上下文 + 重拉注册表即可，
 *   执行 root 已在服务端切好，前端无需整页重建。
 * [CONSTRAINT] 服务端拒绝（404/409）时保留原 activeId 并返回错误，不产生悬空状态。
 */
/**
 * [workspace-session-bind-v1] 切工作区：原地刷新本地状态，并把受控 DeepSeek 窗口切到该工作区会话。
 * [WHY] 单窗口切换地址（Q1 决策）：同一时刻只受控一个 DeepSeek 窗口；切 tab 时把该窗口
 *   导航到绑定 url（有绑定）或新建会话（无绑定），而不是新开窗口。
 * [CONSTRAINT] 服务端拒绝（404）时保留原 activeId；导航失败不阻断本地状态切换。
 */
async function activate(id: string, opts?: { newSession?: boolean }): Promise<{ ok: boolean, error?: string }> {
  try {
    const r = await fetch('/__ai/workspace/activate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
    const j = await r.json().catch(() => null) as { ok?: boolean, error?: string } | null
    if (r.ok && j?.ok) {
      activeId.value = id
      await resetSessionContext()
      // [workspace-epoch-v1] 服务端已 setRoot：通知依赖 root 的面板重拉（否则它们停在旧 root）
      bumpWorkspaceEpoch()
      await load()
      await switchDeepSeekSession(id, opts?.newSession)
      return { ok: true }
    }
    return { ok: false, error: j?.error || `HTTP ${r.status}` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * [workspace-session-bind-v1] 把受控 DeepSeek 窗口切到指定工作区的会话。
 * [WHY] 有绑定 → 导航到绑定 url（复用窗口）；无绑定 → 开新会话（这一次才新开/导航到新会话）。
 * [CONSTRAINT] 动态 import 避免 useWorkspaces ↔ useAiWindow 的模块级循环依赖；失败只告警不抛。
 */
async function switchDeepSeekSession(id: string, newSession?: boolean): Promise<void> {
  try {
    const bound = await getSession(id)
    const { openAiSession } = await import('../ai/useAiWindow')
    const { currentSiteUrl, sidForUrl, MODELS } = await import('../ai/useAiSite')
    // [open-new-session-v1] newSession=true 时导航到**站点首页**（新对话）：
    //   原实现用 bound.url（旧会话 URL）会打开旧对话，用户报告「开新会话还是旧会话」。
    //   从 bound.url 提取 host 找到对应站点首页；无绑定时回退全局 currentSiteUrl。
    let atUrl: string
    if (newSession && bound?.url) {
      try {
        const host = new URL(bound.url).host
        const m = MODELS.find((x) => { try { return new URL(x.url).host === host } catch { return false } })
        atUrl = m ? m.url : currentSiteUrl()
      } catch { atUrl = currentSiteUrl() }
    } else {
      atUrl = bound?.url || currentSiteUrl()
    }
    // [multi-site-parallel-v1] 按绑定 URL 推导 sid：两工作区绑不同站点 → 各自窗口槽位不串
    const targetSid = sidForUrl(atUrl)
    // [key-composite-v1] newSession=true = 站点内新建对话 = 全新 AI 上下文：
    //   显式重置该 (工作区, 新站点) 的首问键，否则复用同名窗口分支不会触发 openSite 的重置，
    //   新对话首次提问会漏注入 SYSTEM.md（用户报告的真实场景）。
    if (newSession) {
      try {
        const m = MODELS.find((x) => { try { return new URL(x.url).host === new URL(atUrl).host } catch { return false } })
        const modelForReset = m?.id || ''
        if (modelForReset) await setFirstPromptSent(id, modelForReset, false)
      } catch { /* 未就绪：下次切换会重试 */ }
    }
    // [workspace-switch-no-first-prompt-v1] 切工作区只导航窗口，**不发首问**：
    //   ① 语义上「切工作区」不等于「开新会话」，用户没要求就给 AI 发消息属越权；
    //   ② 导航重载期间发首问必然撞上油猴未就绪（实测弹「首问未送达」）；
    //   ③ 首问规则仍会在用户真正发起对话时由 copyAndFill 按 sid 去重注入。
    // [workspace-switch-no-first-prompt-v1] 只导航窗口，不发首问（无 initialPrompt 时 openAiSession 本就不发问）。
    await openAiSession({ atUrl, sid: targetSid })
    // [认领语义] 无绑定或强制新会话时把新会话回写到该工作区，避免下次切换又新建
    if (!bound || newSession) await setSession(id, { url: atUrl, sessionId: '' })
    // [session-id-backfill-v1] 空 sessionId 窗口期：新建会话后轮询补全，
    //   油猴的 new-session-created / session-id 回写是异步的，可能晚于本次调用；
    //   补齐后再次切换即可导航到具体会话而非站点默认 URL。
    if (!bound || newSession || !bound.sessionId) void backfillSessionId(id, atUrl)
  } catch { /* 未就绪 / 被拦截：不阻断切换 */ }
}

/**
 * [session-id-backfill-v1] 轮询绑定直到 sessionId 非空（最多 8 次 × 1s）。
 * [WHY] 新建会话后油猴需要时间切到具体会话并回写；期间绑定 sessionId 为空。
 * [CONSTRAINT] 每次轮询重新读绑定；命中即停止；超时静默放弃（下次切换会重试）。
 */
async function backfillSessionId(id: string, fallbackUrl: string): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await new Promise(r => setTimeout(r, 1000))
    const cur = await getSession(id)
    if (cur && cur.sessionId) return
    // 兜底：若绑定丢失（服务端重启 / 被清），把当前已知 url 重新写回
    if (!cur) await setSession(id, { url: fallbackUrl, sessionId: '' })
  }
}

/** 入册已有目录；activate=true 时同时激活并刷新 */
async function register(path: string, activate = false): Promise<{ ok: boolean, error?: string }> {
  try {
    const r = await fetch('/__ai/workspace/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, activate }) })
    const j = await r.json().catch(() => null) as { ok?: boolean, error?: string } | null
    if (r.ok && j?.ok) {
      if (activate) {
        const entry = (j as { workspace?: WorkspaceItem }).workspace
        if (entry?.id) activeId.value = entry.id
        await resetSessionContext()
        // [workspace-epoch-v1] activate=true 时服务端已 setRoot → 面板需重拉
        bumpWorkspaceEpoch()
      }
      await load()
      return { ok: true }
    }
    return { ok: false, error: j?.error || `HTTP ${r.status}` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * [workspace-remove-active-v1] 出册：活跃工作区**也允许移除**（服务端自动回退）。
 * [WHY] 用户要求每个 tab 都能删除；原「活跃不可移」会让点 × 无反应。
 * [CONSTRAINT] 若删除的是当前活跃项且服务端已回退，前端须同步 activeId 与本地会话上下文；
 *   无剩余项时 activeId 置 null，App.vue 的 hasWorkspace 探测由下次 probeWorkspace 处理（不主动 reload）。
 */
async function remove(id: string): Promise<{ ok: boolean, error?: string }> {
  try {
    const wasActive = id === activeId.value
    const r = await fetch('/__ai/workspace/remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
    const j = await r.json().catch(() => null) as { ok?: boolean, error?: string, activeId?: string | null } | null
    if (r.ok && j?.ok) {
      await load()
      if (wasActive) {
        if (j.activeId === null) activeId.value = null
        await resetSessionContext()
        // [workspace-epoch-v1] 移除活跃项 ⇒ 服务端回退到另一 root（或置空）→ 面板需重拉
        bumpWorkspaceEpoch()
      }
      return { ok: true }
    }
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
      if (opts.activate) {
        const entry = (j as { workspace?: WorkspaceItem }).workspace
        if (entry?.id) activeId.value = entry.id
        await resetSessionContext()
        // [workspace-epoch-v1] 新建并激活 = 服务端 setRoot 到新目录 → 面板需重拉
        bumpWorkspaceEpoch()
      }
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
  return { workspaces, activeId, loading, workspaceEpoch, load, activate, register, remove, create, pickPath, listBranches, getSession, setSession, getFirstPromptSent, setFirstPromptSent, findWorkspaceBySid }
}
