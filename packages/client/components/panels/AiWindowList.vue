<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { TOAST_MEDIUM, TOAST_SHORT_MEDIUM } from '../../utils/toast-durations'
import { aiWindowListCollapsed, aiWindowListCollapsed as collapsed } from '../../composables/ui/useAiWindowListCollapse'
import { useToast } from '../../composables/ui/useToast'
import { useWorkspaces } from '../../composables/data/useWorkspaces'

const adding = ref(false)
const addMode = ref<'register' | 'worktree' | 'clone'>('register')
const pathInput = ref('')
const branchInput = ref('')
const urlInput = ref('')
const busy = ref(false)
// [trae-new-workspace-v1] 新建工作区：先选基仓库目录 → 列分支下拉；不让用户手填分支名
const baseRepoPath = ref('')
const branches = ref<string[]>([])
const pickingRepo = ref(false)

const { toast } = useToast()
const { workspaces, activeId, loading, load, activate, register, remove, create, pickPath, listBranches } = useWorkspaces()

const items = computed(() => workspaces.value.map(w => ({
  id: w.id,
  label: w.label,
  root: w.root,
  active: w.id === activeId.value,
})))

onMounted(() => { void load() })

async function onClick(item: { id: string, label: string, active: boolean }): Promise<void> {
  if (item.active) return
  if (busy.value) return
  busy.value = true
  const r = await activate(item.id)
  busy.value = false
  // activate 成功会整页 reload；走到这里说明失败
  toast(`切换工作区失败：${r.error || '未知错误'}`, 'error', TOAST_MEDIUM)
}
/**
 * [trae-new-workspace-v1] 选基仓库目录 → 拉分支列表，供分支下拉消费。
 * [WHY] 需求明确「选了工作区才能选 git 分支，而不是让人填」：分支来自真实 git 仓库，
 *   用户手填易错（拼错/不存在）且无法校验。
 * [CONSTRAINT] 走 /workspace/pick-path（只选路径不入册），避免误触 setRoot + reload。
 */
async function onPickRepo(): Promise<void> {
  if (pickingRepo.value) return
  pickingRepo.value = true
  const r = await pickPath()
  pickingRepo.value = false
  if (!r.ok) {
    if (r.canceled) return
    toast(`选择目录失败：${r.error || (r.unsupported ? '当前平台不支持系统选择器' : '未知错误')}`, 'error', TOAST_MEDIUM)
    return
  }
  baseRepoPath.value = r.path || ''
  branches.value = []
  branchInput.value = ''
  if (!baseRepoPath.value) return
  const b = await listBranches(baseRepoPath.value)
  if (!b.ok) {
    toast(`列分支失败：${b.error || '未知错误'}`, 'warn', TOAST_MEDIUM)
    return
  }
  branches.value = b.list || []
  // [user-friendly] 默认选中当前分支，多数场景直接创建新分支即可
  if (b.current && branches.value.includes(b.current)) branchInput.value = b.current
}
async function submitAdd(): Promise<void> {
  const p = pathInput.value.trim()
  if (!p) { toast('请输入工作区绝对路径', 'warn', TOAST_SHORT_MEDIUM); return }
  if (busy.value) return
  busy.value = true
  let r: { ok: boolean, error?: string }
  if (addMode.value === 'register') {
    r = await register(p, false)
  } else if (addMode.value === 'worktree') {
    if (!baseRepoPath.value) { busy.value = false; toast('请先选择基仓库目录', 'warn', TOAST_SHORT_MEDIUM); return }
    const branch = branchInput.value.trim()
    if (!branch) { busy.value = false; toast('请选择分支', 'warn', TOAST_SHORT_MEDIUM); return }
    r = await create({ mode: 'worktree', path: p, branch, baseRepo: baseRepoPath.value, activate: false })
  } else {
    const url = urlInput.value.trim()
    if (!url) { busy.value = false; toast('请输入仓库 URL', 'warn', TOAST_SHORT_MEDIUM); return }
    r = await create({ mode: 'clone', path: p, url, activate: false })
  }
  busy.value = false
  if (!r.ok) { toast(`操作失败：${r.error || '未知错误'}`, 'error', TOAST_MEDIUM); return }
  pathInput.value = ''
  branchInput.value = ''
  urlInput.value = ''
  baseRepoPath.value = ''
  branches.value = []
  adding.value = false
  toast('工作区已就绪', 'info', TOAST_SHORT_MEDIUM)
}
async function onRemove(item: { id: string, label: string }): Promise<void> {
  if (busy.value) return
  busy.value = true
  const r = await remove(item.id)
  busy.value = false
  if (!r.ok) { toast(`移除失败：${r.error || '未知错误'}`, 'error', TOAST_MEDIUM); return }
  toast(`已移除工作区 ${item.label}`, 'info', TOAST_SHORT_MEDIUM)
}
</script>

<template>
  <aside class="ai-window-list" :class="{ 'is-collapsed': collapsed }" aria-label="工作区列表">
    <div class="awl-top-spacer" aria-hidden="true">
      <div v-if="!aiWindowListCollapsed" class="title">
        <span class="logo" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M13 2L4.5 13.5h6l-1 8.5L18.5 10.5h-6l1-8.5z" fill="url(#ai-runner-grad)" stroke="#4d8bff" stroke-width="1.2" stroke-linejoin="round" /><defs><linearGradient id="ai-runner-grad" x1="4" y1="2" x2="19" y2="22" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#6b83ff" /><stop offset="100%" stop-color="#4d6bfe" /></linearGradient></defs></svg></span>
        <h1>QGM</h1>
      </div>
      <button
        v-tooltip="aiWindowListCollapsed ? '展开左栏' : '收起左栏'"
        class="hdr-collapse-btn"
        type="button"
        :aria-label="aiWindowListCollapsed ? '展开左栏' : '收起左栏'"
        :aria-expanded="!aiWindowListCollapsed"
        @click="aiWindowListCollapsed = !aiWindowListCollapsed"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="3" ry="3" />
          <line x1="9" y1="4" x2="9" y2="20" />
          <polyline v-if="aiWindowListCollapsed" points="14 9 17 12 14 15" />
          <polyline v-else points="17 9 14 12 17 15" />
        </svg>
      </button>
    </div>
    <button
      v-if="!adding"
      v-tooltip="'新建工作区'"
      class="awl-new-workspace"
      type="button"
      aria-label="新建工作区"
      @click="adding = true"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
      <span class="awl-new-workspace-label">新建工作区</span>
    </button>
    <!-- [trae-shell-v1] 原 awl-head 已删：折叠按钮上移到顶部 awl-top-spacer 内 -->
    <div v-if="adding" class="awl-add-row">
      <div class="awl-modes" role="tablist" aria-label="新建模式">
        <button type="button" class="awl-mode" :class="{ active: addMode === 'register' }" @click="addMode = 'register'">
          目录
        </button>
        <button type="button" class="awl-mode" :class="{ active: addMode === 'worktree' }" @click="addMode = 'worktree'">
          分支
        </button>
        <button type="button" class="awl-mode" :class="{ active: addMode === 'clone' }" @click="addMode = 'clone'">
          克隆
        </button>
      </div>
      <!-- [trae-new-workspace-v1] worktree 模式：选基仓库目录 → 下拉选分支（不让人手填） -->
      <template v-if="addMode === 'worktree'">
        <div class="awl-repo-row">
          <input
            v-model="baseRepoPath"
            class="awl-add-input"
            type="text"
            placeholder="基仓库目录（点右侧选择）"
            spellcheck="false"
            readonly
          >
          <button
            class="awl-add"
            type="button"
            aria-label="选择基仓库目录"
            :disabled="busy || pickingRepo"
            @click="onPickRepo"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" /></svg>
          </button>
        </div>
        <select
          v-if="branches.length"
          v-model="branchInput"
          class="awl-add-input"
          :disabled="busy"
        >
          <option value="">
            请选择分支
          </option>
          <option v-for="b in branches" :key="b" :value="b">
            {{ b }}
          </option>
        </select>
        <div v-else-if="baseRepoPath" class="awl-hint">
          该目录非 git 仓库或暂无本地分支
        </div>
      </template>
      <input
        v-if="addMode === 'clone'"
        v-model="urlInput"
        class="awl-add-input"
        type="text"
        placeholder="git@... 或 https://..."
        spellcheck="false"
        :disabled="busy"
      >
      <div class="awl-path-row">
        <input
          v-model="pathInput"
          class="awl-add-input"
          type="text"
          :placeholder="addMode === 'register' ? '/path/to/project' : '/path/to/new'"
          spellcheck="false"
          :disabled="busy"
          @keydown.enter.prevent="submitAdd"
        >
        <button class="awl-add" type="button" aria-label="确认" :disabled="busy" @click="submitAdd">
          ✓
        </button>
        <button class="awl-close awl-add-cancel" type="button" aria-label="取消" @click="adding = false; pathInput = ''; branchInput = ''; urlInput = ''">
          ×
        </button>
      </div>
    </div>
    <ul class="awl-list" role="listbox">
      <li
        v-for="w in items"
        :key="w.id"
        class="awl-item"
        :class="{ active: w.active }"
        role="option"
        :aria-selected="w.active"
        :aria-label="w.label"
        :title="collapsed ? w.label : w.root"
        @click="onClick(w)"
      >
        <span class="awl-dot" aria-hidden="true" />
        <div class="awl-meta">
          <span class="awl-label">{{ w.label }}</span>
          <span class="awl-sub">{{ w.active ? '激活中' : w.root }}</span>
        </div>
        <button
          v-if="!w.active"
          class="awl-close"
          type="button"
          :aria-label="`移除 ${w.label}`"
          @click.stop="onRemove(w)"
        >
          ×
        </button>
      </li>
      <li v-if="!loading && items.length === 0" class="awl-empty">
        尚无注册工作区，点击 + 添加
      </li>
    </ul>
  </aside>
</template>

<style scoped lang="scss">
.title {
  display: flex;
  align-items: center;
  gap: 10px;
}
.logo {
  font-size: 18px;
}
.title h1 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.2px;
}
.env {
  padding: 2px 8px;
  border-radius: var(--radius-10);
  background: var(--surface-2);
  color: var(--text-3);
  font-size: 11px;
  font-weight: 500;
  border: 1px solid var(--border);
  letter-spacing: 0.3px;
}

.ai-window-list {
  flex: 0 0 280px;
  min-width: 160px;
  max-width: 280px;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  overflow: hidden;
}

.ai-window-list.is-collapsed {
  flex: 0 0 48px;
  min-width: 48px;
  max-width: 48px;
}
.ai-window-list.is-collapsed .awl-meta,
.ai-window-list.is-collapsed .awl-close,
.ai-window-list.is-collapsed .awl-new-workspace-label {
  display: none;
}
.ai-window-list.is-collapsed .awl-new-workspace {
  justify-content: center;
  padding: 8px 0;
  margin: 0 6px 8px;
}
.ai-window-list.is-collapsed .awl-item {
  justify-content: center;
  padding: 7px 0;
}

.awl-top-spacer {
  flex: 0 0 48px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-left: 20px;
  min-height: 48px;
}

.awl-new-workspace {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 8px 8px;
  padding: 8px 10px;
  border: 0;
  border-radius: 8px;
  background: var(--primary-bg);
  color: var(--primary);
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  transition:
    background 0.12s,
    color 0.12s;
  flex-shrink: 0;
}
.awl-new-workspace:hover {
  background: var(--primary);
  color: #fff;
}

.hdr-collapse-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  flex-shrink: 0;
}
.hdr-collapse-btn:hover {
  color: var(--text);
  background: rgb(255 255 255 / 6%);
}

.awl-add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  flex-shrink: 0;
  font-size: 14px;
  line-height: 1;
  transition:
    background 0.12s,
    color 0.12s;
}
.awl-add:hover {
  background: rgb(255 255 255 / 6%);
  color: var(--text);
}

/* [multi-workspace-v1] 行内注册输入行 */
.awl-add-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.awl-modes {
  display: flex;
  gap: 4px;
}
.awl-mode {
  flex: 1;
  padding: 3px 0;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: transparent;
  color: var(--text-3);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.12s;
}
.awl-mode.active {
  color: var(--primary, #58a6ff);
  border-color: var(--primary, #58a6ff);
  background: var(--primary-bg);
}
.awl-add-row .awl-add-input {
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg, transparent);
  color: var(--text);
  font-size: 11.5px;
  font-family: ui-monospace, monospace;
}
.awl-path-row {
  display: flex;
  align-items: center;
  gap: 4px;
}
/* [trae-new-workspace-v1] 基仓库选择行：与 .awl-path-row 同构 */
.awl-repo-row {
  display: flex;
  align-items: center;
  gap: 4px;
}
.awl-repo-row .awl-add-input {
  flex: 1;
  min-width: 0;
  cursor: pointer;
}
.awl-hint {
  font-size: 11px;
  color: var(--text-3);
  padding: 2px 0 0;
}
.awl-add-cancel {
  opacity: 1;
}

.awl-list {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 6px;
  list-style: none;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.awl-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.12s ease;
}
.awl-item:hover {
  background: rgba(127, 127, 127, 0.12);
}
/* 非激活项降色阶：凸显激活项 */
.awl-item:not(.active) .awl-label {
  color: var(--text-2);
}
.awl-item:not(.active) .awl-sub {
  color: var(--text-3);
  opacity: 0.7;
}
.awl-item {
  position: relative;
}
.awl-item.active {
  /* [ui-color-token-v1] 硬编码 primary → 语义变量 */
  background: var(--primary-bg);
}
.awl-item.active::before {
  content: '';
  position: absolute;
  left: -6px;
  top: 6px;
  bottom: 6px;
  width: 2px;
  border-radius: 1px;
  background: var(--primary, #58a6ff);
}

.awl-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: rgba(127, 127, 127, 0.28);
  flex-shrink: 0;
}
.awl-item.active .awl-dot {
  background: var(--primary, #58a6ff);
  box-shadow: 0 0 6px var(--primary);
}

.awl-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.awl-label {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.awl-sub {
  /* [ui-type-scale-v1] 辅助下限 11px */
  font-size: var(--font-11);
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.awl-item.active .awl-sub {
  color: var(--primary, #58a6ff);
  opacity: 0.9;
}

.awl-close {
  width: 20px;
  height: 20px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-3);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition:
    opacity 0.12s ease,
    background 0.12s ease,
    color 0.12s ease;
}
.awl-item:hover .awl-close {
  opacity: 1;
}
.awl-close:hover {
  background: rgba(248, 81, 73, 0.14);
  color: var(--danger, #f85149);
}

.awl-empty {
  padding: 12px 8px;
  font-size: 11.5px;
  color: var(--text-3);
  text-align: center;
  cursor: default;
}

/* [ui-responsive-v1][trae-shell-v1] 窄屏响应式条：从 script-panel.scss 迁来；
   原先 .awl-item-name 是笔误（源码里不存在），导致窄屏文字在 48px 条里溢出。
   [CHANGE-IMPACT] aiwin-collapse 测试的断言行径已同步到本文件。 */
@media (max-width: 1100px) {
  .ai-window-list .awl-meta,
  .ai-window-list .awl-close {
    display: none;
  }
  .ai-window-list .awl-item {
    justify-content: center;
    padding: 7px 0;
  }
}
</style>
