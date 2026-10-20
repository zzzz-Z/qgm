<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { TOAST_LONG, TOAST_MEDIUM, TOAST_SHORT_MEDIUM } from '../../utils/toast-durations'
import { aiWindowListCollapsed, aiWindowListCollapsed as collapsed } from '../../composables/ui/useAiWindowListCollapse'
import { useToast } from '../../composables/ui/useToast'
import { useWorkspaces } from '../../composables/data/useWorkspaces'
// [multi-site-matrix-v1] 矩阵视图数据面经中间层收敛：面板不直接耦合站点窗口表
//   （架构守卫 ai-window-sid-wiring 禁止面板直接耦合站点窗口表）
// [site-select-row-removed-v1] 行内站点下拉已移除（2026-10-18 用户要求），MODELS 不再在此组件消费
import { useSiteMatrix } from '../../composables/ai/useSiteMatrix'

const adding = ref(false)
// [trae-single-mode-v1] 只保留「目录」模式（用户明示删掉分支/克隆）。
// [WHY] 原 addMode ref 仅为下游 if 判据提供兼容外壳；openModal 删除后已无任何读写点，
//   连同 worktree/clone 分支一并清除，避免留 unused 死状态。
const pathInput = ref('')
const busy = ref(false)
const pickingRepo = ref(false)

const { toast } = useToast()
const { workspaces, activeId, loading, load, activate, register, remove, pickPath } = useWorkspaces()
// [site-select-row-removed-v1] setSession 原本只服务行内站点下拉（onSiteChange），下拉移除后改为不取用
// [multi-site-matrix-v1] 站点矩阵数据面（窗口状态 + 站点映射经中间层，解耦窗口表）
const matrix = useSiteMatrix()

const items = computed(() => workspaces.value.map((w) => {
  return {
    id: w.id,
    label: w.label,
    root: w.root,
    active: w.id === activeId.value,
  }
}))

// [multi-site-matrix-v1] 切工作区 / 注册表变更后刷新绑定
watch(activeId, () => { void matrix.loadAllSessions() })

onMounted(() => { void load(); void matrix.loadAllSessions() })

async function onClick(item: { id: string, label: string, active: boolean }): Promise<void> {
  if (item.active) return
  if (busy.value) return
  busy.value = true
  const r = await activate(item.id)
  busy.value = false
  // [workspace-switch-inplace-v1] 原地切换不再 reload ⇒ 成功与失败都会走到这里，必须判 r.ok
  if (!r.ok) { toast(`切换工作区失败：${r.error || '未知错误'}`, 'error', TOAST_MEDIUM) }
}
async function submitAdd(): Promise<void> {
  const p = pathInput.value.trim()
  if (!p) { toast('请先点击选择目录', 'warn', TOAST_SHORT_MEDIUM); return }
  if (busy.value) return
  busy.value = true
  const r = await register(p, false)
  busy.value = false
  if (!r.ok) { toast(`操作失败：${r.error || '未知错误'}`, 'error', TOAST_MEDIUM); return }
  pathInput.value = ''
  adding.value = false
  toast('工作区已就绪', 'info', TOAST_SHORT_MEDIUM)
}
/**
 * [new-workspace-direct-pick-v1] 点击「新建工作区」直接弹系统文件夹选择器，选完即注册。
 * [WHY] 原流程是「弹模态 → 点『选择目录』 → 再弹系统选择器 → 确认」四步；
 *   用户要求跳过模态，一步到位。register(p, false) 与 submitAdd 的语义一致（入册但不激活）。
 * [CONSTRAINT] 取消（204）静默返回，不 toast；平台不支持（501）才提示。
 *   防重入用 pickingRepo（与 onPickTarget 共用同一个 ref）。
 */
async function onNewWorkspaceDirect(): Promise<void> {
  if (pickingRepo.value || busy.value) return
  pickingRepo.value = true
  const picked = await pickPath()
  pickingRepo.value = false
  if (!picked.ok) {
    if (picked.canceled) return
    toast(`选择目录失败：${picked.error || (picked.unsupported ? '当前平台不支持系统选择器' : '未知错误')}`, 'error', TOAST_MEDIUM)
    return
  }
  const p = String(picked.path || '').trim()
  if (!p) return
  busy.value = true
  const r = await register(p, false)
  busy.value = false
  if (!r.ok) { toast(`新建工作区失败：${r.error || '未知错误'}`, 'error', TOAST_MEDIUM); return }
  toast('工作区已就绪', 'info', TOAST_SHORT_MEDIUM)
}
/**
 * [new-workspace-direct-pick-v1] 原 openModal（弹窗入口）已删：模板改为直连 onNewWorkspaceDirect，
 * 一步弹系统选择器。弹窗状态重置（pathInput/adding）由 submitAdd 与 closeModal 各自负责。
 * [CONSTRAINT] aiwin-collapse 测试断言同步改为「不得再出现 openModal 调用点」。
 */
/**
 * [trae-modal-pick-v1] 关闭「新建工作区」弹窗并清空状态。
 * [CONSTRAINT] 取消与确认后都走本函数；submitAdd 成功后自身也清一次（幂等）。
 */
function closeModal(): void {
  adding.value = false
  pathInput.value = ''
}
/**
 * [trae-modal-pick-v1] 通用「选目标目录」：目录模式选自己、分支/克隆模式选新工作区父目录。
 * [WHY] 手填绝对路径易错（拼错 / 不存在 / 无权限）；统一走系统选择器。
 * [CONSTRAINT] 与 onPickRepo 共用 pickPath()（同一个 /workspace/pick-path）；pickingRepo 防重入。
 */
async function onPickTarget(): Promise<void> {
  if (pickingRepo.value) return
  pickingRepo.value = true
  const r = await pickPath()
  pickingRepo.value = false
  if (!r.ok) {
    if (r.canceled) return
    toast(`选择目录失败：${r.error || (r.unsupported ? '当前平台不支持系统选择器' : '未知错误')}`, 'error', TOAST_MEDIUM)
    return
  }
  pathInput.value = r.path || ''
}
async function onRemove(item: { id: string, label: string }): Promise<void> {
  if (busy.value) return
  const wasActive = item.id === activeId.value
  busy.value = true
  const r = await remove(item.id)
  busy.value = false
  if (!r.ok) { toast(`移除失败：${r.error || '未知错误'}`, 'error', TOAST_MEDIUM); return }
  // [workspace-remove-active-v1] 删活跃项时 DeepSeek 窗口仍停在原会话：服务端已回退 root，
  //   但受控窗口不会自动导航——明确告知用户，避免误以为窗口已跟随切换。
  if (wasActive) {
    toast(`已移除工作区 ${item.label}；DeepSeek 窗口仍停在该会话，切换其他工作区即可跟随切换`, 'info', TOAST_LONG)
  } else {
    toast(`已移除工作区 ${item.label}`, 'info', TOAST_SHORT_MEDIUM)
  }
}
/**
 * [workspace-open-newwin-v1] 在新浏览器窗口打开该工作区。
 * [WHY] 用户要求每个工作区项可单独在新窗口打开，便于并行查看不同工作区；
 *   通过 ?workspaceId=<id> 让新窗口启动时自动切到该工作区（App.vue 读取 query 参数）。
 * [CONSTRAINT] 使用 window.open 打开同源页面，不加 noopener（新窗口需要读 sessionStorage 上的位置信息）。
 */
async function onOpenNewWindow(item: { id: string, label: string }): Promise<void> {
  // [open-new-session-v1] 用户诉求：点击该按钮应「在该工作区的受控 AI 窗口里开新会话」。
  // [WHY] 原实现直接 openAiSession({atUrl: bound.url})：bound.url 是旧会话 URL ⇒ 打开的还是旧对话。
  //   改走 ws.activate(id, { newSession: true }) → switchDeepSeekSession(_, true) 会把目标 URL
  //   折叠回站点首页（新对话），而不是继续沿用该工作区已绑定的旧会话。
  // [CONSTRAINT] 不加 newSession=true 时按钮语义退化为「切工作区」，与「开新会话」不符；不带浏览器新窗口。
  try {
    const { useWorkspaces } = await import('../../composables/data/useWorkspaces')
    const ws = useWorkspaces()
    await ws.activate(item.id, { newSession: true })
  } catch {
    toast('打开新会话失败，请检查站点窗口是否就绪', 'error', TOAST_MEDIUM)
  }
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
      @click="onNewWorkspaceDirect"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><line x1="12" y1="11" x2="12" y2="17" /><line x1="9" y1="14" x2="15" y2="14" /></svg>
      <span class="awl-new-workspace-label">新建工作区</span>
    </button>
    <!-- [trae-shell-v1] 原 awl-head 已删：折叠按钮上移到顶部 awl-top-spacer 内 -->
    <!-- [trae-modal-pick-v1-template] 原内联 awl-add-row 整块已迁至模态弹窗（Teleport 到 body） -->
    <Teleport to="body">
      <div
        v-if="adding"
        class="awl-modal-mask"
        role="dialog"
        aria-modal="true"
        aria-label="新建工作区"
        @click.self="closeModal"
      >
        <div class="awl-modal-card">
          <header class="awl-modal-head">
            <h3>新建工作区</h3>
            <button class="awl-modal-close" type="button" aria-label="关闭" @click="closeModal">
              ×
            </button>
          </header>

          <p class="awl-modal-hint">
            选择一个已存在的项目目录
          </p>
          <button
            class="awl-modal-pick"
            type="button"
            :disabled="busy || pickingRepo"
            @click="onPickTarget"
          >
            {{ pathInput ? pathInput : '点击选择目录' }}
          </button>

          <footer class="awl-modal-foot">
            <button class="awl-modal-btn" type="button" :disabled="busy" @click="closeModal">
              取消
            </button>
            <button class="awl-modal-btn primary" type="button" :disabled="busy" @click="submitAdd">
              确认
            </button>
          </footer>
        </div>
      </div>
    </Teleport>

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
        </div>
        <button
          v-tooltip="'在该工作区开新会话'"
          class="awl-open-new"
          type="button"
          :aria-label="`在新窗口打开 ${w.label}`"
          @click.stop="onOpenNewWindow(w)"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
        </button>
        <button
          v-tooltip="w.active ? '移除当前工作区（自动切到下一个）' : '移除'"
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
.ai-window-list.is-collapsed .awl-open-new,
.ai-window-list.is-collapsed .awl-new-workspace-label {
  display: none;
}
/* [left-rail-collapsed-content-v1] 收起态只留顶部折叠开关：隐藏「新建工作区」按钮与工作区列表 */
.ai-window-list.is-collapsed .awl-new-workspace,
.ai-window-list.is-collapsed .awl-list {
  display: none;
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
  justify-content: flex-end;
  gap: 5px;
  margin: 0 8px 10px;
  padding: 4px 2px;
  /* [left-rail-ui-v5] 通栏描边按钮 → 右对齐无边框文字入口：左栏主体是列表，按钮只作轻量入口 */
  border: 0;
  background: transparent;
  color: var(--text-3);
  font-size: 12.5px;
  font-weight: 500;
  letter-spacing: 0.2px;
  cursor: pointer;
  transition: color 0.14s ease;
  flex-shrink: 0;
}
.awl-new-workspace:hover {
  color: var(--primary);
}
.awl-new-workspace:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 1px;
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
  /* [workspace-panel-ui-v2] 6px → 8px：与 48px 顶部条和卡片圆角对齐，减少贴边感 */
  padding: 8px 8px;
  list-style: none;
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  gap: 3px;
  scrollbar-gutter: stable;
}

.awl-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  /* [workspace-list-ui-v3] 8px → 7px 纵向、10px 横向：压缩行高至约 34px，
     换取同屏更多工作区，同时保留 7px 圆角与左侧点击热区。 */
  padding: 8px 10px 8px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition:
    background 0.12s ease,
    box-shadow 0.12s ease;
}
/* [left-rail-ui-v4] 悬停与激活拉开层级：悬停中性底，激活项再加描边（原样式已有 box-shadow） */
.awl-item:hover {
  background: color-mix(in srgb, var(--text) 8%, transparent);
}
/* [workspace-panel-ui-v2] 键盘可达：列表项可聚焦（role=option 已具备，补齐可见焦点环） */
.awl-item:focus-visible {
  outline: 2px solid var(--primary, #58a6ff);
  outline-offset: -2px;
}
/* 非激活项降色阶：凸显激活项 */
.awl-item:not(.active) .awl-label {
  color: var(--text-2);
}
/* [workspace-list-ui-v3] 激活项标题升为主色，与左侧激活条呼应。 */
.awl-item.active .awl-label {
  color: var(--primary, #58a6ff);
  font-weight: 600;
}
.awl-item.active {
  /* [ui-color-token-v1] 硬编码 primary → 语义变量 */
  background: var(--primary-bg);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary) 30%, transparent);
}
/* [workspace-list-ui-v3] 激活条由浮空 2px 改为贴左内缘 3px 实心条，
   与卡片圆角贴合，选中感更明确。 */
.awl-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 3px;
  border-radius: 0 2px 2px 0;
  background: var(--primary, #58a6ff);
}

.awl-dot {
  /* [workspace-list-ui-v3] 状态点兼作色标：未激活为中性灰，激活为主色。
     尺寸由 8px 收到 7px，配合压缩后的行高不显臃肿。 */
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: rgba(127, 127, 127, 0.3);
  flex-shrink: 0;
  transition:
    background 0.14s ease,
    box-shadow 0.14s ease;
}
.awl-item.active .awl-dot {
  background: var(--primary, #58a6ff);
  box-shadow: 0 0 6px color-mix(in srgb, var(--primary) 60%, transparent);
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
  /* [workspace-panel-ui-v2] 行高固定，避免多语言/字号下高度抖动 */
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.awl-open-new {
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
  cursor: pointer;
  opacity: 0;
  transition:
    opacity 0.12s ease,
    background 0.12s ease,
    color 0.12s ease;
}
.awl-item:hover .awl-open-new {
  opacity: 1;
}
.awl-open-new:hover {
  background: var(--primary-bg);
  color: var(--primary);
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
  /* [workspace-panel-ui-v2] 空态给虚线容器，让「尚无注册工作区」看起来是提示位而非渲染失败 */
  margin: 2px 8px;
  padding: 14px 10px;
  border: 1px dashed var(--border);
  border-radius: 7px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-3);
  text-align: center;
  cursor: default;
}

/* [awl-narrow-name-visible-v1] 原 `@media (max-width: 1100px)` 整块已删。
   [WHY] 它把 .awl-meta（名称+路径）在 ≤1100px 一律 display:none —— 与折叠态无关，
     于是在常见笔记本视口（~1014px）展开左栏后名称仍消失（用户报告「名称怎么没了」，
     浏览器实测：is-collapsed=false、面板 280px，.awl-meta 仍为 none）。该规则迁自旧文件里
     拼错的 .awl-item-name（恒不命中，无副作用），改正为真类名后从「无效」变成「真隐藏」。
   [CONSTRAINT] 折叠成图标条的诉求由 .is-collapsed 规则承担（左栏默认即折叠态）；
     展开态面板固定 280px，容纳名称绰绰有余 ⇒ 窄屏不再隐藏任何文字。
   [CHANGE-IMPACT] aiwin-collapse 测试的窄屏断言已同步为「窄屏不得隐藏 .awl-meta」。 */

/* [trae-modal-pick-v1-style] 新建工作区弹窗：遮罩 + 居中卡片 */
.awl-modal-mask {
  position: fixed;
  inset: 0;
  z-index: 9000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(0 0 0 / 45%);
  backdrop-filter: blur(2px);
}
.awl-modal-card {
  width: min(440px, 92vw);
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 18px;
  border-radius: 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  box-shadow: 0 12px 32px rgb(0 0 0 / 35%);
}
.awl-modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.awl-modal-head h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}
.awl-modal-close {
  width: 24px;
  height: 24px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-3);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}
.awl-modal-close:hover {
  background: rgb(255 255 255 / 8%);
  color: var(--text);
}
.awl-modal-hint {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-3);
}
.awl-modal-pick {
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  font-family: ui-monospace, monospace;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.awl-modal-pick:hover:not(:disabled) {
  border-color: var(--primary, #58a6ff);
  color: var(--text);
}
.awl-modal-pick:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.awl-modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
.awl-modal-btn {
  padding: 6px 16px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
}
.awl-modal-btn:hover:not(:disabled) {
  color: var(--text);
  background: rgb(255 255 255 / 6%);
}
.awl-modal-btn.primary {
  border-color: var(--primary, #58a6ff);
  background: var(--primary-bg);
  color: var(--primary, #58a6ff);
}
.awl-modal-btn.primary:hover:not(:disabled) {
  background: var(--primary, #58a6ff);
  color: #fff;
}
.awl-modal-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
</style>
