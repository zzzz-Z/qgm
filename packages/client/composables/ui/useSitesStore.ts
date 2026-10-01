// [unified-site-store-v1] 会话历史 + 站点信息统一到一个 localStorage 对象持久化
// [WHY] 现状分散在 5+ 个键，切站点时各处独立读写易不一致；收敛到单对象 schema
// [CONSTRAINT] 旧键保留作迁移源；读写 try/catch 兜底；无 localStorage 环境降级为空对象
// [CHANGE-IMPACT] 后续 useAppStorage / useAiSite 读写统一走本模块，旧函数标记 deprecated

export interface SiteSession {
  id: string
  url: string
  title: string
  createdAt: number
  handedOff?: boolean
}

export interface SiteEntry {
  history: SiteSession[]
  activeId: string
  url: string
  updatedAt: number
}

export interface UnifiedStore {
  activeModelId: string
  sites: Record<string, SiteEntry>
}

const KEY = '__ai_sites_unified'

function emptyStore(): UnifiedStore {
  return { activeModelId: '', sites: {} }
}

function safeRead(): UnifiedStore {
  try {
    if (typeof localStorage === 'undefined') return emptyStore()
    const raw = localStorage.getItem(KEY)
    if (!raw) return emptyStore()
    const obj = JSON.parse(raw)
    if (!obj || typeof obj !== 'object') return emptyStore()
    return {
      activeModelId: String(obj.activeModelId || ''),
      sites: (obj.sites && typeof obj.sites === 'object') ? obj.sites : {},
    }
  } catch { return emptyStore() }
}

function safeWrite(store: UnifiedStore): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(KEY, JSON.stringify(store))
  } catch { /* swallow: 配额/隐私模式 */ }
}

export function loadStore(): UnifiedStore { return safeRead() }

export function saveStore(store: UnifiedStore): void { safeWrite(store) }

export function loadSite(modelId: string): SiteEntry | null {
  const s = safeRead()
  return s.sites[modelId] || null
}

export function saveSite(modelId: string, entry: SiteEntry): void {
  const s = safeRead()
  s.sites[modelId] = { ...entry, updatedAt: Date.now() }
  safeWrite(s)
}

export function setActiveModelId(modelId: string): void {
  const s = safeRead()
  s.activeModelId = modelId
  safeWrite(s)
}

export function getActiveModelId(): string {
  return safeRead().activeModelId
}

// [sites-migrate-v1] 旧键一次性迁移：读 4 类旧键 → 合并到 sites[<id>] → 打标记
// [WHY] 用户从旧版本升上来时旧数据仍在 5+ 个键里；首次启动迁移一次即可切到新存储
// [CONSTRAINT] 迁移后旧键保留（回滚源）；__ai_sites_migrated=1 防重入；异常静默不阻断
// [CHANGE-IMPACT] 迁移完成后 loadSite/loadStore 能直接读到旧站点历史与活动会话
const MIGRATE_FLAG = '__ai_sites_migrated'
const LEGACY_MODEL_KEY = '__ai_model_id'
const LEGACY_URL_KEY = '__ai_site_url'
const LEGACY_HISTORY_PREFIX = '__ai_session_history__'
const LEGACY_ACTIVE_PREFIX = '__ai_active_session_id__'

/** 首次启动时把旧分散键合并到统一 store；已迁移过则短路 */
export function migrateIfNeeded(): void {
  try {
    if (typeof localStorage === 'undefined') return
    if (localStorage.getItem(MIGRATE_FLAG) === '1') return
    const modelId = localStorage.getItem(LEGACY_MODEL_KEY) || ''
    if (!modelId) {
      // 无旧模型键 = 全新用户；打标记直接切到新存储
      localStorage.setItem(MIGRATE_FLAG, '1')
      return
    }
    const url = localStorage.getItem(LEGACY_URL_KEY) || ''
    const histRaw = localStorage.getItem(LEGACY_HISTORY_PREFIX + modelId)
    const activeId = localStorage.getItem(LEGACY_ACTIVE_PREFIX + modelId) || ''
    let history: SiteSession[] = []
    try { if (histRaw) history = JSON.parse(histRaw) as SiteSession[] } catch { /* 损坏：忽略 */ }
    const store = safeRead()
    store.activeModelId = modelId
    store.sites[modelId] = { history, activeId, url, updatedAt: Date.now() }
    safeWrite(store)
    localStorage.setItem(MIGRATE_FLAG, '1')
  } catch { /* swallow: 迁移失败不阻断主流程，下次启动重试 */ }
}
