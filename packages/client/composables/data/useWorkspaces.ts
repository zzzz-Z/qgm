// [multi-workspace-v1] 工作区注册表客户端状态：GET /workspace/registry 列表 + activate/register/remove。
// [workspace-switch-inplace-v1] 激活走服务端 setRoot，前端**原地**刷新本地状态（不整页 reload）——
//   原 reload 会在启动期触发 openAiSession 自动开新 AI 站点窗口，与「切换不打开新窗口」冲突。
// [CONSTRAINT] 模块级单例状态（与 useAiWindowTable 同范式）；load() 静默失败——
//   服务端不可达时面板显示空态而非抛未处理 rejection（承重测试在 happy-dom 下无后端）。

import { ref } from 'vue'

/** [workspace-schema-v2] 内联会话绑定（homeUrl 与 sessionUrl 分离） */
export interface WorkspaceSessionInline {
  homeUrl: string
  sessionUrl: string
  sessionId: string
  updatedAt: number
}

/** 注册表条目（与 core 的 WorkspaceEntry 同构） */
export interface WorkspaceItem {
  id: string
  root: string
  label: string
  addedAt: number
  /** [workspace-schema-v2] 内联会话绑定；无绑定则 undefined */
  session?: WorkspaceSessionInline
  /** [workspace-schema-v2] 内联首问标记（按 modelId） */
  firstPromptSent?: Record<string, boolean>
}

// [workspace-nav-confirm-v1] 导航确认：切换工作区导航到 sessionUrl 后，若 8s 内没收到该站点的
//   url-updated 帧，说明绑定的会话 URL 可能已失效（站点会重定向回首页）。只 warn 不改数据——
//   纠正仍由 url-updated 回写负责（D2：被动纠正 + 本地超时兜底，不做主动 HEAD 探测）。
export const NAV_CONFIRM_TIMEOUT_MS = 8_000
const pendingNavBySid = new Map<string, ReturnType<typeof setTimeout>>()

/** [workspace-nav-confirm-v1] 导航已确认（收到该 sid 的 url-updated）；幂等 */
export function confirmNav(sid: string): void {
  if (!sid) return
  const t = pendingNavBySid.get(sid)
  if (t === undefined) return
  clearTimeout(t)
  pendingNavBySid.delete(sid)
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
 * [workspace-root-single-exit-v1] 执行 root 变更后的**全部**前端副作用，唯一出口。
 * [WHY] 原先 activate / register / remove / create 四个入口各写一遍清理，
 *   任何新增切换路径只要漏抄就会让模块级缓存（load-rules 的 Promise 缓存）跨工作区泄漏；
 *   收敛到本函数后，入口只需 await 一次，判据由 rules-cache-invalidate.node-test.ts 守住。
 * [CONSTRAINT] 各步失败必须静默降级（模块未就绪 / storage 不可用），不得阻断切换；
 *   新增需要随 root 失效的模块级状态时，加在这里而不是调用方。
 */
async function applyRootChanged(): Promise<void> {
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
  // [rules-cache-invalidate-v1] 切/建/删工作区必须失效 SYSTEM.md / AGENTS.md 的 Promise 缓存：
  //   load-rules 的缓存是模块级单例、与 root 无关，不失效则新工作区首问仍带上一工作区的规则。
  try {
    const { clearRulesCache } = await import('../ai/load-rules')
    clearRulesCache()
  } catch { /* 未就绪：忽略 */ }
  // [workspace-epoch-v1] root 已变更 ⇒ 通知依赖 root 的面板重拉（否则它们停在旧 root）
  bumpWorkspaceEpoch()
}

/**
 * [multi-site-parallel-v1] 由窗口槽位 sid 反查所属工作区。
 * [WHY] 回写链路只知 frame 的 sid；若用 activeId 会写错工作区（并行时 A 的回写落进 B）。
 * [CONSTRAINT] 遍历服务端 sessions，用 sidForUrl 比对 URL host；未命中返回 null（调用方回退 activeId）。
 */
async function findWorkspaceBySid(sid: string, targetUrl = ''): Promise<string | null> {
  if (!sid) return null
  try {
    const r = await fetch('/__ai/workspace/session')
    if (!r.ok) return null
    const j = await r.json().catch(() => null) as { sessions?: Record<string, { url?: string }> } | null
    const sessions = j?.sessions || {}
    const { sidForUrl } = await import('../ai/useAiSite')
    // [workspace-schema-v2] 精确 URL 命中优先：同站点多工作区（退化配置）下 host 比对会撞车，
    //   而 sessionUrl 非空的条目能唯一定位。全部未命中才回落 host 比对。
    const entries = Object.entries(sessions)
    for (const [wid, s] of entries) {
      if (!s || typeof s.url !== 'string' || !s.url) continue
      if (s.url === targetUrl) return wid
    }
    let ambiguous = 0
    let hit: string | null = null
    for (const [wid, s] of entries) {
      if (!s || typeof s.url !== 'string' || !s.url) continue
      if (sidForUrl(s.url) === sid) { ambiguous += 1; hit = wid }
    }
    if (ambiguous > 1) {
      console.warn(`[useWorkspaces] findWorkspaceBySid 按 host 命中 ${ambiguous} 个工作区（同站点多工作区为退化配置），取其一：${hit}`)
    }
    return hit
  } catch { return null }
}

/**
 * [workspace-session-bind-v1] 读某工作区的会话绑定；无则返回 null。
 * [workspace-session-source-v1] 数据源是 registry 条目内联的 session，**不是** /workspace/session。
 * [WHY] 该端点返回合并形状 `url = sessionUrl || homeUrl`，前端无法区分「首页」与「具体会话」；
 *   本计划要按 sessionUrl 是否为空分支导航，必须拿到分离字段。
 * [CONSTRAINT] 服务端不可达 / 无绑定一律返回 null，由调用方决定「新建会话」。
 */
async function getSession(id: string): Promise<WorkspaceSessionInline | null> {
  try {
    const r = await fetch('/__ai/workspace/registry')
    if (!r.ok) return null
    const j = await r.json().catch(() => null) as { workspaces?: WorkspaceItem[] } | null
    const e = (j?.workspaces || []).find(w => w && w.id === id)
    const s = e?.session
    if (!s || typeof s.homeUrl !== 'string' || typeof s.sessionUrl !== 'string') return null
    return { homeUrl: s.homeUrl, sessionUrl: s.sessionUrl, sessionId: String(s.sessionId || ''), updatedAt: Number(s.updatedAt) || 0 }
  } catch { return null }
}

/** [workspace-schema-v2] 写入形状：kind 显式区分「绑站点」与「绑会话」，缺省由服务端推断 */
export interface SetSessionPayload {
  kind?: 'site' | 'session'
  homeUrl?: string
  sessionUrl?: string
  sessionId?: string
  /** @deprecated 旧两参兼容：kind 缺省时按 sessionId 是否非空推断 */
  url?: string
}

/**
 * [workspace-session-bind-v1] 写某工作区的 DeepSeek 会话绑定。
 * [CONSTRAINT] 失败静默（不阻断切换）；由回写链路与切换链路主动调用。
 */
async function setSession(id: string, session: SetSessionPayload): Promise<boolean> {
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
      await applyRootChanged()
      await load()
      await switchDeepSeekSession(id, opts?.newSession)
      return { ok: true }
    }
    return { ok: false, error: j?.error || `HTTP ${r.status}` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** [workspace-schema-v2] 导航目标选择（纯函数，供守卫测试直接覆盖） */
export function pickNavUrl(p: { sessionUrl: string, homeUrl: string, newSession: boolean, fallbackUrl: string }): string {
  if (p.newSession) return p.homeUrl || p.fallbackUrl
  return p.sessionUrl || p.homeUrl || p.fallbackUrl
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
    const { currentSiteUrl, sidForUrl } = await import('../ai/useAiSite')
    // [workspace-schema-v2] 导航目标由 pickNavUrl 单点决定（newSession / sessionUrl / homeUrl / 回退）
    const atUrl = pickNavUrl({
      sessionUrl: bound?.sessionUrl || '',
      homeUrl: bound?.homeUrl || '',
      newSession: Boolean(newSession),
      fallbackUrl: currentSiteUrl(),
    })
    // [multi-site-parallel-v1] 按绑定 URL 推导 sid：两工作区绑不同站点 → 各自窗口槽位不串
    const targetSid = sidForUrl(atUrl)
    // [key-composite-v1] newSession=true = 站点内新建对话 = 全新 AI 上下文：
    //   显式重置该 (工作区, 新站点) 的首问键，否则复用同名窗口分支不会触发 openSite 的重置，
    //   新对话首次提问会漏注入 SYSTEM.md（用户报告的真实场景）。
    // [site-from-sid-v1] 站点 id 直接从 targetSid 反推（winSidOf / sidForUrl 的互逆函数），
    //   与 useAiWindow 侧口径一致；不再经 MODELS 反查 host（多一个失败分支且与 sid 语义漂移）。
    if (newSession) {
      try {
        const { modelIdFromSid } = await import('../ai/useAiSite')
        const modelForReset = modelIdFromSid(targetSid)
        if (modelForReset) await setFirstPromptSent(id, modelForReset, false)
      } catch { /* 未就绪：下次切换会重试 */ }
    }
    // [workspace-switch-no-first-prompt-v1] 切工作区只导航窗口，**不发首问**：
    //   ① 语义上「切工作区」不等于「开新会话」，用户没要求就给 AI 发消息属越权；
    //   ② 导航重载期间发首问必然撞上油猴未就绪（实测弹「首问未送达」）；
    //   ③ 首问规则仍会在用户真正发起对话时由 copyAndFill 按 sid 去重注入。
    // [workspace-switch-no-first-prompt-v1] 只导航窗口，不发首问（无 initialPrompt 时 openAiSession 本就不发问）。
    await openAiSession({ atUrl, sid: targetSid })
    // [workspace-nav-confirm-v1] 导航后挂确认超时：目标 URL 若是已失效的会话路径，
    //   站点会静默重定向回首页，用户看到「又新建了」而没有任何提示。
    //   收到任一 url-updated 即视为导航成功（不只是命中该 URL——站点重定向也算一次导航完成）。
    confirmNav(targetSid)
    pendingNavBySid.set(targetSid, setTimeout(() => {
      pendingNavBySid.delete(targetSid)
      console.warn('[useWorkspaces] 导航后 8s 未收到 URL 变更，绑定的会话可能已失效：', { id, atUrl, sid: targetSid })
    }, NAV_CONFIRM_TIMEOUT_MS))
    // [认领语义] 无绑定或强制新会话时把新会话回写到该工作区，避免下次切换又新建。
    // [workspace-schema-v2] 新建会话时只认领站点首页（kind:'site'），具体会话 URL 由回写链路补
    if (!bound || newSession) await setSession(id, { kind: 'site', homeUrl: atUrl })
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
    // [workspace-schema-v2] 判据含 sessionUrl：只补到 sessionId 但 URL 仍是首页时，导航会回到首页
    if (cur && (cur.sessionUrl || cur.sessionId)) return
    // 兜底：绑定丢失（服务端重启 / 被清）时把已知首页写回
    if (!cur) await setSession(id, { kind: 'site', homeUrl: fallbackUrl })
  }
  // [session-id-backfill-v1] 超时不再静默：这是「切换后仍停在首页」的主要可观测信号
  console.warn('[useWorkspaces] backfillSessionId 超时未拿到会话绑定，工作区', id)
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
        await applyRootChanged()
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
        await applyRootChanged()
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
        await applyRootChanged()
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
