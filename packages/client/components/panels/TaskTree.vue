<script setup lang="ts">
// [task-tree-v1] PLAN 5.2 计划依赖树（deps 优先视图）
import { computed, ref, watch } from 'vue'

type TodoStatus = 'pending' | 'doing' | 'done' | 'skipped' | 'failed' | 'blocked'

interface TodoItem {
  id: string
  desc: string
  status: string
  parentId: string | null
  deps: string[]
  children: string[]
}

interface Tier {
  id: string
  name: string
  order: number
  type: string
  total: number
  done: number
  pending: number
  items: Array<{ id: string, desc: string, status: string, tier: string, deps: string[], verify: string | null }>
}

interface Props {
  items?: TodoItem[]
  // [plan-tiers-tree-v1]
  tiers?: Tier[]
  // [task-tree-current-v1] 当前执行目标（来自 state.json.goal / 循环目标），用于高亮匹配项
  currentGoal?: string
}

/** 组件接收的 props 定义 */
const props = withDefaults(defineProps<Props>(), { items: () => [], tiers: () => [], currentGoal: '' })

/** 图标 */
const ICON: Record<TodoStatus, string> = {
  pending: '○',
  doing: '',
  done: '✓',
  skipped: '!',
  failed: '✗',
  blocked: '⚠',
}
/** 判定为「进行中」的状态集合 */
const RUNNING_STATUSES = new Set(['doing', 'in-progress'])

// [compact-tree] 默认折叠全部；只有含 running 项的 tier 才展开
const collapsedTiers = ref<Set<string>>(new Set((props.tiers || []).map(t => t.id)))

/** 标识 */
const byId = computed(() => {
  const m = new Map<string, TodoItem>()
  for (const it of props.items) m.set(it.id, it)
  return m
})
/** 排序后的任务列表 */
const sorted = computed(() => {
  // 拓扑排序：先无未完成依赖的，再按原序
  const list = [...props.items]
  const out: TodoItem[] = []
  const seen = new Set<string>()
  let guard = 0
  while (out.length < list.length && guard++ < list.length * 2) {
    for (const it of list) {
      if (seen.has(it.id)) continue
      if (depsDone(it)) { out.push(it); seen.add(it.id) }
    }
    // 若一轮无进展，剩余全部塞入（防死锁）
    if (out.length === 0) break
    for (const it of list) { if (!seen.has(it.id)) { /* next iter */ }
    }
    if (out.length < list.length && list.every(it => seen.has(it.id) || !depsDone(it))) {
      for (const it of list) { if (!seen.has(it.id)) { out.push(it); seen.add(it.id) }
      }
      break
    }
  }
  return out
})
/** 数量 */
const readyCount = computed(() => sorted.value.filter(it => norm(it.status) === 'pending' && depsDone(it)).length)
/** 启用的层级数量 */
const useTiers = computed(() => props.tiers && props.tiers.length > 0)
/** 可见的层级列表 */
const visibleTiers = computed(() => (props.tiers || []).filter(t => t.items && t.items.length))

// [task-tree-autoexpand-v1] tiers 或 currentGoal 变化时自动展开含运行/当前项的 tier
watch([() => props.tiers, () => props.currentGoal], ([list]) => {
  const autoOpen = new Set<string>()
  for (const t of list || []) {
    if (tierIsLoading(t)) autoOpen.add(t.id)
  }
  if (!autoOpen.size) return
  const s = new Set(collapsedTiers.value)
  let changed = false
  for (const id of autoOpen) { if (s.has(id)) { s.delete(id); changed = true } }
  if (changed) collapsedTiers.value = s
}, { immediate: true, deep: true })

/**
 * 执行 norm
 * @param s - s
 */
function norm(s: string): TodoStatus {
  const v = String(s || 'pending')
  return (['pending', 'doing', 'done', 'skipped', 'failed', 'blocked'].includes(v) ? v : 'pending') as TodoStatus
}

/**
 * 执行 deps Done
 * @param it - it
 */
function depsDone(it: TodoItem): boolean {
  return it.deps.every((d) => {
    const dep = byId.value.get(d)
    return !dep || dep.status === 'done' || dep.status === 'skipped'
  })
}

/**
 * 判断是否为 Running
 * @param s - s
 */
function isRunning(s: string): boolean { return RUNNING_STATUSES.has(String(s || '')) }

/**
 * 切换 Tier
 * @param id - id
 */
function toggleTier(id: string): void {
  const s = new Set(collapsedTiers.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  collapsedTiers.value = s
}
/**
 * 判断是否为 Tier Collapsed
 * @param id - id
 */
function isTierCollapsed(id: string): boolean { return collapsedTiers.value.has(id) }
/**
 * 执行 tier Pct
 * @param t - t
 */
function tierPct(t: Tier): number { return t.total ? Math.round(t.done / t.total * 100) : 0 }
/**
 * 执行 status Class
 * @param s - s
 */
function statusClass(s: string): string { return `tt-${norm(s)}` }

// [task-tree-current-v1] 当前执行匹配：currentGoal 非空且与 desc/id 有 ≥4 字公共片段即视为当前
function isCurrent(it: { id: string, desc: string }): boolean {
  const g = String(props.currentGoal || '').trim().toLowerCase()
  if (!g) return false
  const d = String(it.desc || '').toLowerCase()
  const id = String(it.id || '').toLowerCase()
  if (id && g.includes(id)) return true
  // 取 desc 中连续 4 字及以上片段做匹配（简化：整段包含或反向包含）
  if (d && g.includes(d.slice(0, Math.min(8, d.length)))) return true
  if (g && d.includes(g.slice(0, Math.min(8, g.length)))) return true
  return false
}

// [task-tree-autoexpand-v1] tier 是否含当前执行项（用于自动展开 + loading 图标）
/**
 * 执行 tier Has Current
 * @param t - t
 */
function tierHasCurrent(t: Tier): boolean {
  return (t.items || []).some(it => isCurrent(it))
}
/**
 * 执行 tier Has Running
 * @param t - t
 */
function tierHasRunning(t: Tier): boolean {
  return (t.items || []).some(it => isRunning(it.status))
}
/**
 * 执行 tier Is Loading
 * @param t - t
 */
function tierIsLoading(t: Tier): boolean {
  return tierHasCurrent(t) || tierHasRunning(t)
}
</script>

<template>
  <div class="tt">
    <div class="tt-head">
      <span class="tt-title">计划树</span>
      <span class="tt-meta">可执行 {{ readyCount }} / 共 {{ items.length }}</span>
    </div>
    <!-- [plan-tiers-tree-v1] -->
    <div v-if="useTiers" class="tt-tiers">
      <div v-for="t in visibleTiers" :key="t.id" class="tt-tier">
        <button class="tt-tier-head" type="button" @click="toggleTier(t.id)">
          <span class="tt-tier-icon" :class="{ 'is-loading': tierIsLoading(t) }">{{ tierIsLoading(t) ? '⟳' : (isTierCollapsed(t.id) ? '▸' : '▾') }}</span>
          <span class="tt-tier-name">{{ t.name }}</span>
          <span class="tt-tier-progress">{{ t.done }}/{{ t.total }}</span>
          <span class="tt-tier-bar"><span class="tt-tier-bar-fill" :style="{ width: tierPct(t) + String.fromCharCode(37) }" /></span>
        </button>
        <ul v-if="!isTierCollapsed(t.id)" class="tt-tier-list">
          <li v-for="it in t.items" :key="it.id" class="tt-item" :class="statusClass(it.status)">
            <span class="tt-icon" :class="{ 'is-running': isRunning(it.status) }">{{ isRunning(it.status) ? '⟳' : ICON[norm(it.status)] }}</span>
            <span class="tt-desc" :class="{ 'is-current': isCurrent(it) }">{{ it.desc }}</span>
            <span v-if="isCurrent(it)" class="tt-current-badge">进行中</span>
            <span v-if="it.deps.length" class="tt-deps">← {{ it.deps.join(',') }}</span>
          </li>
        </ul>
      </div>
    </div>
    <ul v-if="!useTiers" class="tt-list">
      <li v-for="it in sorted" :key="it.id" class="tt-item" :class="[statusClass(it.status)]">
        <span class="tt-icon" :class="{ 'is-running': isRunning(it.status) }">{{ isRunning(it.status) ? '⟳' : ICON[norm(it.status)] }}</span>
        <span class="tt-desc" :class="{ 'is-current': isCurrent(it) }">{{ it.desc }}</span>
        <span v-if="isCurrent(it)" class="tt-current-badge">进行中</span>
        <span v-if="it.deps.length" class="tt-deps">← {{ it.deps.join(',') }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.tt {
  padding: 8px 12px;
  font-family: var(--mono, monospace);
  font-size: 11px;
}
.tt-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  color: var(--text-3, #94a3b8);
}
.tt-title {
  font-weight: 600;
}
.tt-meta {
  flex: 1;
}
.tt-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.tt-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 4px;
  border-radius: 3px;
}
.tt-icon {
  font-size: 12px;
  width: 14px;
  text-align: center;
  flex-shrink: 0;
}
.tt-desc {
  color: var(--text-2, #cbd5e1);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tt-deps {
  color: var(--text-3, #94a3b8);
  font-size: 10px;
  flex-shrink: 0;
}
.tt-pending .tt-icon {
  color: #6b7280;
}
.tt-doing .tt-icon {
  color: #3b82f6;
}
.tt-done .tt-icon {
  color: #22c55e;
}
.tt-failed .tt-icon {
  color: #ef4444;
}
.tt-blocked .tt-icon {
  color: #eab308;
}
.tt-skipped .tt-icon {
  color: #94a3b8;
}
.tt-done .tt-desc {
  opacity: 0.6;
  text-decoration: line-through;
}

/* [task-tree-current-v1] 当前执行高亮 */
.tt-desc.is-current {
  color: #f8fafc;
  font-weight: 600;
  background: rgb(59 130 246 / 14%);
  padding: 0 4px;
  border-radius: 3px;
}
.tt-current-badge {
  flex-shrink: 0;
  font-size: 10px;
  padding: 0 6px;
  border-radius: 8px;
  background: rgb(59 130 246 / 22%);
  color: #bfdbfe;
}
/* [plan-tiers-tree-v1] */
.tt-tiers {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.tt-tier {
  border: 1px solid var(--border, #334155);
  border-radius: 4px;
  overflow: hidden;
}
.tt-tier-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 8px;
  background: var(--surface-2, #252525);
  border: 0;
  color: var(--text-2, #cbd5e1);
  font-size: 11px;
  cursor: pointer;
  text-align: left;
}
/* [task-tree-autoexpand-v1] 父级 loading 图标旋转 */
@keyframes tt-spin {
  to {
    transform: rotate(360deg);
  }
}
.tt-tier-icon.is-loading {
  display: inline-block;
  animation: tt-spin 1.2s linear infinite;
  color: #3b82f6;
}
.tt-tier-icon {
  font-size: 10px;
  width: 10px;
}
.tt-tier-name {
  flex: 1;
}
.tt-tier-progress {
  font-size: 10px;
  color: var(--text-3, #94a3b8);
}
.tt-tier-bar {
  width: 60px;
  height: 4px;
  background: var(--surface, #1a1a1a);
  border-radius: 2px;
  overflow: hidden;
}
.tt-tier-bar-fill {
  display: block;
  height: 100%;
  background: #22c55e;
  transition: width 0.2s;
}
.tt-tier-list {
  list-style: none;
  margin: 0;
  padding: 4px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tt-done .tt-failed .tt-blocked
/* [compact-tree] running 图标旋转 */
.tt-icon.is-running {
  color: #3b82f6;
  display: inline-block;
  animation: tt-spin 1.2s linear infinite;
}
@keyframes tt-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
