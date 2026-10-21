<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { TOAST_LONG, TOAST_LONGEST, TOAST_MEDIUM, TOAST_SHORT_MEDIUM } from '../../utils/toast-durations'
// [theme-toggle-dock-v1] 主题开关显式 import：模板里对 auto-import 符号赋值会被展开成不可赋值的调用表达式
//   （整个模块 SyntaxError → 白屏），故赋值一律落在 script 的 toggleTheme 里。
import { theme } from '../../composables/ui/useAppStorage'
// [left-tools-v1] 底部工具条依赖的符号**显式 import**（不靠 auto-import）：
//   SFC 单测用 @vitejs/plugin-vue 编译、不经 unplugin-auto-import ⇒ 靠 auto-import 的符号在挂载测试里
//   直接 ReferenceError（aiwin-collapse 实测）。显式绑定对构建与测试都成立，且同名会遮蔽 auto-import。
import { updateUserscript, useUserscriptUpdateWatcher } from '../../composables/ui/useUserscriptUpdate'
import { getTransport, transportKind } from '../../composables/ai/useAiTransport'
import { getActiveWinSid } from '../../composables/ai/useAiWindow'
import { log } from '../../utils/log'
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
// [left-tools-v1] 底部工具条（主题 / 传输链路 / 更新油猴脚本）从 SidePane 迁入本组件。
//   状态与副作用逐字沿用原实现，避免迁家时改变行为。
const userscriptBadge = useUserscriptUpdateWatcher()

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
function toggleTheme(): void {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
}
function onTransportChange(e: Event) {
  const v = (e.target as HTMLSelectElement).value
  transportKind.value = v === 'headless' ? 'headless' : 'tampermonkey'
  window.location.reload()
}
function onLoginGui() {
  try {
    const t = getTransport()
    const sid = getActiveWinSid()
    const ok = t.sendLoginGui?.(sid)
    if (!ok) {
      toast('当前通道不支持引导登录', 'warn', TOAST_MEDIUM)
      return
    }
    toast('已打开有头窗口，请登录 DeepSeek 后关闭该窗口', 'info', TOAST_LONGEST)
  } catch (e) {
    log.error('[headless-login-gui] 触发失败:', e)
  }
}
function onUpdateUserscript() {
  void updateUserscript().then(() => userscriptBadge.markSeen())
}
</script>

<template>
  <aside class="ai-window-list" :class="{ 'is-collapsed': collapsed }" aria-label="工作区列表">
    <!-- [brand-toggle-v1] 顶部品牌行：闪电图标本身就是折叠/展开开关（用户要求删掉右上角的 ◧ 按钮，
         把功能挪到闪电上）。因此顶栏不能再 aria-hidden——那会把开关从无障碍树里摘掉。
         折叠态下 QGM 文字隐藏、只剩居中的闪电，点它展开。 -->
    <div class="awl-top-spacer">
      <button
        v-tooltip="aiWindowListCollapsed ? '展开左栏' : '收起左栏'"
        class="logo-btn"
        type="button"
        :aria-label="aiWindowListCollapsed ? '展开左栏' : '收起左栏'"
        :aria-expanded="!aiWindowListCollapsed"
        @click="aiWindowListCollapsed = !aiWindowListCollapsed"
      >
        <span class="logo" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M13 2L4.5 13.5h6l-1 8.5L18.5 10.5h-6l1-8.5z" fill="url(#ai-runner-grad)" stroke="#4d8bff" stroke-width="1.2" stroke-linejoin="round" /><defs><linearGradient id="ai-runner-grad" x1="4" y1="2" x2="19" y2="22" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#6b83ff" /><stop offset="100%" stop-color="#4d6bfe" /></linearGradient></defs></svg></span>
      </button>
      <h1 v-if="!aiWindowListCollapsed" class="brand-name">
        QGM
      </h1>
    </div>
    <button
      v-if="!adding"
      v-tooltip="'新建工作区'"
      class="awl-new-workspace"
      type="button"
      aria-label="新建工作区"
      @click="onNewWorkspaceDirect"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" /><line x1="12" y1="8" x2="12" y2="15" /><line x1="8.5" y1="11.5" x2="15.5" y2="11.5" /></svg>
      <span class="awl-new-workspace-label">新建工作区</span>
    </button>
    <!-- [trae-shell-v1] 原 awl-head 已删：[brand-toggle-v1] 折叠入口现由顶部闪电图标承担（独立 ◧ 按钮已移除） -->
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
        <!-- [workspace-folder-lead-v1] 原左侧 7px 状态圆点已删（用户要求「去掉圆点，换一个文件夹图标，稍微大一点」）：
             文件夹图标顶到行首并放大到 14px（原在标题行内是 11px）。激活态仍靠颜色区分
             （.awl-item.active .awl-folder → primary），只是不再用圆点。 -->
        <svg class="awl-folder" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
        <div class="awl-meta">
          <span class="awl-title-row">
            <span class="awl-label">{{ w.label }}</span>
          </span>
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
    <!-- [left-tools-v1] 主题 / 传输链路 / 更新油猴脚本：原在右侧面板 SidePane 底部（用户视作「右下角」），
         按要求挪到左栏底部 = 全局左下角。折叠成 48px 图标条时纵向排列并隐藏文字型下拉（沿用 SidePane 旧范式：
         下拉里有「油猴/无头」两个中文选项，48px 放不下，展开后即可切）。 -->
    <div class="awl-tools" :class="{ 'is-collapsed': collapsed }">
      <button
        v-tooltip="theme === 'dark' ? '切换到亮色模式' : '切换到暗色模式'"
        class="theme-toggle" aria-label="切换主题"
        @click="toggleTheme"
      >
        <svg v-if="theme === 'dark'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><line x1="12" y1="2" x2="12" y2="4" /><line x1="12" y1="20" x2="12" y2="22" /><line x1="4.93" y1="4.93" x2="6.34" y2="6.34" /><line x1="17.66" y1="17.66" x2="19.07" y2="19.07" /><line x1="2" y1="12" x2="4" y2="12" /><line x1="20" y1="12" x2="22" y2="12" /><line x1="4.93" y1="19.07" x2="6.34" y2="17.66" /><line x1="17.66" y1="6.34" x2="19.07" y2="4.93" /></svg>
        <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>
      </button>
      <div class="transport-switch" role="group" aria-label="AI 传输链路（切换后自动刷新）" title="AI 传输链路（切换后自动刷新）">
        <select
          class="transport-select"
          :value="transportKind"
          aria-label="AI 传输链路"
          @change="onTransportChange"
        >
          <option value="tampermonkey">
            油猴
          </option>
          <option value="headless">
            无头
          </option>
        </select>
        <template v-if="transportKind === 'headless'">
          <span class="transport-sep" aria-hidden="true" />
          <button
            v-tooltip="'引导登录：打开有头窗口，登录后关窗即可（登录态落盘复用）'"
            aria-label="引导登录"
            class="login-gui-toggle"
            @click="onLoginGui"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><polyline points="10 17 15 12 10 7" /><line x1="15" y1="12" x2="3" y2="12" /></svg>
          </button>
        </template>
        <span class="transport-sep" aria-hidden="true" />
        <button
          v-tooltip="'安装 / 更新油猴脚本（打开本地分发端点，Tampermonkey 会弹出安装或更新确认）'"
          :aria-label="userscriptBadge.hasUpdate.value ? '油猴脚本有新版本，点击更新' : '更新油猴脚本'"
          class="userscript-toggle"
          :class="{ 'has-update': userscriptBadge.hasUpdate.value }"
          @click="onUpdateUserscript"
        >
          <span v-if="userscriptBadge.hasUpdate.value" class="userscript-dot" aria-hidden="true" />
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" /><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14" /></svg>
        </button>
      </div>
    </div>
  </aside>
</template>

<style scoped lang="scss">
/* [brand-toggle-v1] 闪电图标 = 折叠/展开开关：外观仍是品牌位，命中区按按钮做（26×26 ≥ 22px 可点） */
.logo-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  /* 图标 20px 居中 ⇒ 起点 +3px；负 margin 抵掉，视觉左缘仍与 .awl-item 文字对齐 */
  margin-left: -3px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  flex-shrink: 0;
}
.logo-btn:hover {
  background: rgb(255 255 255 / 6%);
}
.logo-btn:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 1px;
}
.logo {
  display: inline-flex;
  font-size: 18px;
}
.brand-name {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.2px;
  white-space: nowrap;
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
  align-items: center;
  justify-content: flex-start;
  gap: 10px;
  /* 左缘与 .awl-item 文字对齐（容器 8 + 条目 12 = 20px）；右侧留 8px 不贴边 */
  padding: 0 8px 0 20px;
  min-height: 48px;
}
/* [brand-toggle-v1] 折叠态（48px 图标条）：只留闪电并居中，它同时是展开按钮 */
.ai-window-list.is-collapsed .awl-top-spacer {
  justify-content: center;
  padding: 0;
}
.ai-window-list.is-collapsed .logo-btn {
  margin-left: 0;
}

.awl-new-workspace {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  /* [left-rail-align-v1] 与 .awl-item 左缘对齐：列表容器 padding 8 + 条目 padding-left 12 = 20px，
     按钮 margin 8 + padding-left 12 才能对齐同一竖线。 */
  margin: 0 8px 10px;
  padding: 4px 10px 4px 12px;
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
/* [workspace-folder-lead-v1] 文件夹图标升为行首标识（原 11px 小图标 + 7px 圆点两件套 → 单一个 14px 图标）。
   [active-as-hover-v1] 图标不再单独上蓝色（那是「选中态三件套」的一部分，用户要求撤掉）。 */
.awl-title-row {
  display: flex;
  align-items: center;
  min-width: 0;
}
.awl-folder {
  flex-shrink: 0;
  color: var(--text-3);
  transition: color 0.14s ease;
}
/* [active-as-hover-v1] 选中态 = 悬停那一层灰：蓝色底 / 蓝色内描边 / 左缘蓝色竖条全撤
   （用户：选中可以和悬停搞成一样的灰色，不要蓝色边和底）。
   唯一保留的非蓝差异是标签加粗一档，否则列表里完全看不出哪项是当前工作区。 */
.awl-item.active {
  background: color-mix(in srgb, var(--text) 8%, transparent);
}
.awl-item.active .awl-label {
  font-weight: 600;
}

/* [workspace-folder-lead-v1] `.awl-dot` 规则已删：状态点被行首 14px 文件夹图标取代，
   [active-as-hover-v1] 选中色也不再走 primary（见上），删除而不是 display:none——不留给后人复活的机会。 */

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

/* ── 底部工具条（[left-tools-v1] 自 SidePane 迁入：主题 / 传输链路 / 更新油猴脚本） ───────────
   margin-top:auto 让它在列表被隐藏（折叠态）时仍贴底；展开态由 .awl-list 的 flex:1 把它推下去。 */
.awl-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  margin-top: auto;
  padding: 8px 10px;
  border-top: 1px solid var(--border);
  background: var(--surface);
}
/* 折叠态（48px 图标条）：纵向排列；文字型下拉放不下 ⇒ 隐藏（展开后即可切，与 SidePane 旧范式一致） */
.awl-tools.is-collapsed {
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 8px 4px;
}
.awl-tools.is-collapsed .transport-switch {
  margin: 0;
}
.awl-tools.is-collapsed .transport-select {
  display: none;
}
.awl-tools .theme-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  flex-shrink: 0;
}
.awl-tools .theme-toggle:hover {
  color: var(--text);
  background: var(--surface-2);
}
.awl-tools .transport-switch {
  display: inline-flex;
  align-items: stretch;
  height: 28px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-2);
  overflow: hidden;
  min-width: 0;
}
.awl-tools .transport-select {
  border: 0;
  background: transparent;
  color: var(--text-2);
  font-size: 11.5px;
  padding: 0 4px;
  cursor: pointer;
  min-width: 0;
}
.awl-tools .transport-sep {
  flex: 0 0 1px;
  align-self: stretch;
  width: 1px;
  background: var(--border);
}
.awl-tools .login-gui-toggle,
.awl-tools .userscript-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
}
.awl-tools .login-gui-toggle:hover,
.awl-tools .userscript-toggle:hover {
  background: var(--primary-bg);
  color: var(--primary);
}
.awl-tools .userscript-toggle {
  position: relative;
}
.awl-tools .userscript-dot {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--primary);
}
</style>
