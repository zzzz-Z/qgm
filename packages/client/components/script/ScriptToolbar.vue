<template>
  <div class="tpl-bar">
    <!-- [fix-restore-templates] 模板按钮（删 draft-toolbar 时误删） -->
    <button
      v-for="t in templates" :key="t.id" v-tooltip="`模板：${t.label} — ${t.title}`" class="tpl-chip"
      @click="emit('applyTemplate', t.code)"
    >
      {{ t.label }}
    </button>
    <div class="tpl-spacer" />
    <!-- [decision-in-header-v1] 决策模式三档选择（输入框顶部） -->
    <DecisionPolicySwitch class="tpl-dps" />
    <button
      ref="skillTriggerRef"
      v-tooltip="'选择要注入 AI 提示词的规则'" aria-label="选择要注入 AI 提示词的规则"
      data-skill-trigger class="skill-trigger"
      @mousedown.prevent="toggleSkillMenu"
    >
      <span class="skill-trigger-label">☰ 规则</span>
      <!-- [tplbar-copy-v1] 单一计数：选中/总数 合成为 选中/总，去掉并列两个数字 -->
      <span
        class="skill-badge" :class="{ 'skill-badge-empty': !selectedSkillNames.length }"
        :title="`已选 ${selectedSkillNames.length} · 可用 ${skillsList.length}`"
      >{{ selectedSkillNames.length }}/{{ skillsList.length }}</span>
    </button>
    <Teleport to="body">
      <div v-if="skillMenuOpen" data-skill-menu class="skill-menu-fixed" :style="skillMenuPos" @mousedown.stop>
        <div class="skill-menu-head">
          共 {{ skillsList.length }} 个可用规则
        </div>
        <input
          v-model="skillFilter"
          class="skill-search"
          type="text"
          placeholder="搜索规则…"
          @mousedown.stop
        >
        <div v-if="skillsLoading" class="skill-row skill-loading">
          加载中…
        </div>
        <div v-if="!skillsLoading && !filteredSkills.length" class="skill-row skill-empty">
          {{ skillFilter.trim() ? '无匹配规则' : '暂无规则' }}
        </div>
        <label v-for="sk in filteredSkills" :key="sk.name" class="skill-row">
          <input type="checkbox" :checked="selectedSkillNames.includes(sk.name)" @change="emit('toggleSkill', sk.name)">
          <span class="skill-name">{{ sk.name }}</span>
          <span class="skill-src" :class="`src-${sk.source || 'base'}`">{{ sk.source === 'user' ? '用户'
            : (sk.source
              === 'agents' ? '全局' : '系统') }}</span>
        </label>
        <div class="skill-hint">
          选择后，点「运行」发送给 AI 的 prompt 会带上这些规则
        </div>
      </div>
    </Teleport>
    <button
      v-tooltip="'清空编辑器与附件'"
      aria-label="清空编辑器与附件" class="ghost-btn"
      :disabled="running || (!script && !attachedFilesCount)" @click="emit('clearAll')"
    >
      <svg
        class="ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
      >
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        <path d="M10 11v6M14 11v6" />
      </svg>
      <span>清空</span>
    </button>
    <!-- [niuma-mode] 牛马模式 -->
    <label
      v-tooltip="'牛马模式：开启后 AI 持续自驱不停（轮末续推 / 无回复重发 / DONE 不终止）；关闭后仅手动推进。'"
      class="niuma-toggle"
    >
      <input :checked="niumaMode" type="checkbox" @change="emit('update:niumaMode', ($event.target as HTMLInputElement).checked)">
      <span>牛马</span>
    </label>
    <button
      v-if="running || isLoopActive || autoTakeoverEnabled"
      v-tooltip="loopPaused ? '发送：结束本次循环，回到待发状态' : '暂停：不取 AI 脚本、不接收工作台结果'"
      :aria-label="loopPaused ? '发送脚本' : '暂停循环'"
      class="primary-btn stop head-run"
      @click="emit('pauseAll')"
    >
      <svg
        class="ico ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
      >
        <polygon v-if="loopPaused" points="6 4 20 12 6 20 6 4" />
        <template v-else>
          <line x1="9" y1="4" x2="9" y2="20" />
          <line x1="15" y1="4" x2="15" y2="20" />
        </template>
      </svg>
      <span data-mark="[pause-toggle-label-v1]">{{ autoTakeoverEnabled ? '暂停' : (loopPaused ? '发送' : '暂停') }}</span>
    </button>
    <button
      v-else
      v-tooltip="'开始：执行当前脚本，随后自动把结果发 AI 并执行下一轮'" aria-label="开始循环" class="primary-btn takeover head-run" data-mark="[run-btn-copy-v1]"
      @click="emit('toggleAutoTakeover')"
    >
      <svg
        class="ico ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
      >
        <polygon points="6 4 20 12 6 20 6 4" />
      </svg><span>发送</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue' // [skill-search-v1]
import DecisionPolicySwitch from '../panels/DecisionPolicySwitch.vue'

interface Template { id: string, label: string, title: string, code: string }
interface SkillInfo { name: string, content?: string, source?: 'base' | 'user' | 'agents' }

/** 组件接收的 props 定义 */
const props = defineProps<{
  templates: Template[]
  selectedSkillNames: string[]
  skillsList: SkillInfo[]
  skillsLoading: boolean
  running: boolean
  isLoopActive: boolean
  autoTakeoverEnabled: boolean
  // [loop-paused-toggle-v1] 循环暂停标志：按钮在「暂停 / 恢复」间切换
  loopPaused: boolean
  autoTakeoverCountdown: number
  niumaMode: boolean
  script: string
  attachedFilesCount: number
  onLoadSkills?: () => void
}>()

/** 派发 */
const emit = defineEmits<{
  'applyTemplate': [code: string]
  'toggleSkill': [name: string]
  'clearAll': []
  'pauseAll': []
  'toggleAutoTakeover': []
  'update:niumaMode': [v: boolean]
}>()

/** skill引用 */
const skillTriggerRef = ref<HTMLElement | null>(null)
/** 打开 */
const skillMenuOpen = ref(false)
/** skill 菜单弹出位置 */
const skillMenuPos = ref<{ top: string, left: string, maxHeight: string }>({ top: '0px', left: '0px', maxHeight: '320px' })
/** 过滤 */
const skillFilter = ref('')

/** skill 列表 */
const filteredSkills = computed(() => {
  const kw = skillFilter.value.trim().toLowerCase()
  if (!kw) return props.skillsList
  return props.skillsList.filter(s => s.name.toLowerCase().includes(kw))
})

onMounted(() => document.addEventListener('mousedown', onGlobalMousedown))
onBeforeUnmount(() => document.removeEventListener('mousedown', onGlobalMousedown))

/**
 * 切换 Skill Menu
 */
function toggleSkillMenu() {
  const el = skillTriggerRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const maxHeight = Math.max(120, window.innerHeight - rect.bottom - 16)
  skillMenuPos.value = { top: `${rect.bottom + 4}px`, left: `${rect.left}px`, maxHeight: `${maxHeight}px` }
  skillMenuOpen.value = !skillMenuOpen.value
  if (skillMenuOpen.value) { skillFilter.value = ''; props.onLoadSkills?.() }
}

/**
 * 响应 Global Mousedown
 * @param e - e
 */
function onGlobalMousedown(e: MouseEvent) {
  if (!skillMenuOpen.value) return
  const t = e.target as HTMLElement | null
  if (t && (t.closest('[data-skill-menu]') || t.closest('[data-skill-trigger]'))) return
  skillMenuOpen.value = false
}
</script>

<style scoped lang="scss">
.skill-menu-fixed {
  position: fixed;
  z-index: 9999;
  min-width: 220px;
  max-height: 320px;
  overflow-y: auto;
  padding: 6px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-8);
  box-shadow: 0 8px 24px rgb(15 30 60 / 15%);
}

.skill-menu-fixed .skill-search {
  display: block;
  width: 100%;
  box-sizing: border-box;
  margin: 4px 0 6px;
  padding: 5px 8px;
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-4);
  background: var(--surface-2);
  color: inherit;
  outline: none;
}

.skill-menu-fixed .skill-search:focus {
  border-color: var(--primary);
}

.skill-menu-fixed .skill-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: var(--radius-4);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}

.skill-menu-fixed .skill-row:hover {
  background: var(--surface-2);
}

.skill-menu-fixed .skill-row input {
  margin: 0;
  accent-color: var(--primary);
}

.skill-menu-fixed .skill-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-menu-fixed .skill-src {
  flex-shrink: 0;
  padding: 1px 5px;
  border-radius: var(--radius-2);
  font-size: 10px;
  font-weight: 600;
}

.skill-menu-fixed .skill-src.src-base {
  background: var(--primary-bg);
  color: var(--primary);
}

.skill-menu-fixed .skill-src.src-agents {
  background: var(--warning-bg, #fffbeb);
  color: var(--warning, #d97706);
}

.skill-menu-fixed .skill-src.src-user {
  background: var(--success-bg);
  color: var(--success);
}

.skill-menu-fixed .skill-loading,
.skill-menu-fixed .skill-empty {
  color: var(--text-3);
  font-style: italic;
  cursor: default;
}

.skill-menu-fixed .skill-hint {
  margin-top: 4px;
  padding: 6px 8px 4px;
  border-top: 1px solid var(--border);
  font-size: 10px;
  color: var(--text-3);
  line-height: 1.5;
}

.skill-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--border-2);
  border-radius: var(--radius-12);
  background: var(--surface);
  color: var(--text-2);
  font-size: var(--font-12);
  font-weight: 500;
  user-select: none;
  cursor: pointer;
  transition: 0.12s;
  flex-shrink: 0;
}

.skill-trigger:hover {
  border-color: var(--primary);
  color: var(--primary);
  background: var(--primary-bg);
}

.skill-count {
  padding: 0 5px;
  font-size: 10px;
  color: var(--text-3);
  background: var(--surface-2);
  border-radius: var(--radius-2);
  line-height: 14px;
  flex-shrink: 0;
}

.skill-menu-head {
  padding: 4px 8px;
  margin-bottom: 4px;
  font-size: 10px;
  color: var(--text-3);
  border-bottom: 1px solid var(--border);
}

.skill-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 5px;
  background: var(--primary);
  color: #fff;
  border-radius: var(--radius-8);
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  flex-shrink: 0;
}

.skill-badge-empty {
  background: var(--border-2);
  color: var(--text-3);
}

.skill-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 9999;
  min-width: 220px;
  max-height: 320px;
  overflow-y: auto;
  padding: 6px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-8);
  box-shadow: 0 8px 24px rgb(15 30 60 / 15%);
}

.skill-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: var(--radius-4);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}

.skill-row:hover {
  background: var(--surface-2);
}

.skill-row input {
  margin: 0;
  accent-color: var(--primary);
}

.skill-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-src {
  flex-shrink: 0;
  padding: 1px 5px;
  border-radius: var(--radius-2);
  font-size: 10px;
  font-weight: 600;
}

.skill-src.src-base {
  background: var(--primary-bg);
  color: var(--primary);
}

.skill-src.src-user {
  background: var(--success-bg);
  color: var(--success);
}

.skill-loading,
.skill-empty {
  color: var(--text-3);
  font-style: italic;
  cursor: default;
}

.skill-loading:hover,
.skill-empty:hover {
  background: transparent;
}

.skill-hint {
  margin-top: 4px;
  padding: 6px 8px 4px;
  border-top: 1px solid var(--border);
  font-size: 10px;
  color: var(--text-3);
  line-height: 1.5;
}

.tpl-bar {
  display: flex !important;
  align-items: center !important;
  gap: 6px !important;
  padding: 8px 14px !important;
  background: var(--surface) !important;
  border-bottom: 1px solid var(--border) !important;
  flex-shrink: 0 !important;
  min-height: 40px !important;
}

.tpl-chip {
  display: inline-flex !important;
  align-items: center !important;
  padding: 4px 10px !important;
  font-size: 12px !important;
  font-family: var(--mono, monospace) !important;
  color: var(--text-3) !important;
  background: transparent !important;
  border: 1px solid transparent !important;
  border-radius: var(--radius-6) !important;
  cursor: pointer !important;
  transition: all 0.15s ease !important;
}

.tpl-chip:hover {
  color: var(--text) !important;
  background: var(--surface-2) !important;
  border-color: var(--border) !important;
}

.tpl-spacer {
  flex: 1 1 auto !important;
  min-width: 8px !important;
}

.tpl-bar .ghost-btn:hover:not(:disabled),
.tpl-bar .primary-btn:hover:not(:disabled) {
  color: var(--text) !important;
  background: var(--surface-2) !important;
  border-color: var(--border) !important;
}

.tpl-bar .ghost-btn:disabled,
.tpl-bar .primary-btn:disabled {
  opacity: 0.35 !important;
  cursor: not-allowed !important;
}

.tpl-bar .ghost-btn > svg,
.tpl-bar .ghost-btn > .ico-svg,
.tpl-bar .primary-btn > svg,
.tpl-bar .primary-btn > .ico-svg {
  display: inline-block !important;
  width: 14px !important;
  height: 14px !important;
  flex-shrink: 0 !important;
  fill: none !important;
  stroke: currentColor !important;
  stroke-width: 2 !important;
}

.tpl-bar .ghost-btn > span,
.tpl-bar .primary-btn > span {
  display: inline-block !important;
  white-space: nowrap !important;
  line-height: 1 !important;
}

.tpl-bar .ghost-btn.ghost,
.tpl-bar .ghost-btn.head-run {
  color: var(--text-2) !important;
}

.tpl-bar .ghost-btn.ghost:hover:not(:disabled),
.tpl-bar .ghost-btn.head-run:hover:not(:disabled) {
  color: var(--text) !important;
  background: var(--surface-2) !important;
  border-color: var(--border-2) !important;
}

.tpl-bar .primary-btn.stop,
.tpl-bar .primary-btn.stop.head-run {
  color: var(--primary) !important;
  border-color: var(--primary) !important;
  background: transparent !important;
  font-weight: 600 !important;
}

.tpl-bar .primary-btn.stop:hover:not(:disabled),
.tpl-bar .primary-btn.stop.head-run:hover:not(:disabled) {
  color: var(--primary-hover) !important;
  border-color: var(--primary-hover) !important;
  background: var(--primary-bg) !important;
}

.tpl-bar .primary-btn.cancel {
  color: var(--danger) !important;
  border-color: var(--danger) !important;
}

.tpl-bar .skill-trigger {
  display: inline-flex !important;
  align-items: center !important;
  gap: 6px !important;
  height: 28px !important;
  padding: 0 10px 0 8px !important;
  border-radius: 6px !important;
  border: 1px solid var(--border) !important;
  background: var(--surface-2) !important;
  color: var(--text-2) !important;
  font-size: 12px !important;
  font-family: inherit !important;
  cursor: pointer !important;
  transition: all 0.15s ease !important;
  flex-shrink: 0 !important;
}

.tpl-bar .skill-trigger:hover {
  color: var(--text) !important;
  border-color: var(--border-2) !important;
}

.tpl-bar .skill-trigger-label {
  display: inline-block !important;
  color: inherit !important;
  white-space: nowrap !important;
}

.tpl-bar .skill-badge {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  min-width: 18px !important;
  height: 18px !important;
  padding: 0 5px !important;
  border-radius: 10px !important;
  background: var(--primary) !important;
  color: var(--bg) !important;
  font-size: 10px !important;
  font-weight: 700 !important;
  font-family: var(--mono, monospace) !important;
  line-height: 1 !important;
}

.tpl-bar .skill-badge-empty {
  background: var(--surface) !important;
  color: var(--text-3) !important;
  box-shadow: inset 0 0 0 1px var(--border) !important;
}

.tpl-bar .skill-count {
  display: inline-block !important;
  color: var(--text-3) !important;
  font-size: 11px !important;
  font-family: var(--mono, monospace) !important;
  margin-left: 2px !important;
}

.tpl-bar .tpl-chip {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  height: 26px !important;
  padding: 0 12px !important;
  border-radius: 6px !important;
  border: 1px solid transparent !important;
  background: transparent !important;
  color: var(--text-3) !important;
  font-size: 12px !important;
  font-family: var(--mono, monospace) !important;
  font-weight: 500 !important;
  cursor: pointer !important;
  transition: all 0.15s ease !important;
  flex-shrink: 0 !important;
}

.tpl-bar .tpl-chip:hover {
  color: var(--text) !important;
  background: var(--surface-2) !important;
}

.tpl-bar .tpl-spacer {
  flex: 1 1 auto !important;
  min-width: 12px !important;
}

.tpl-bar .kbd-hint {
  flex-shrink: 0 !important;
  color: var(--text-3) !important;
  font-size: 11px !important;
  font-family: var(--mono, monospace) !important;
  opacity: 0.6 !important;
}

.tpl-bar button.ghost-btn,
.tpl-bar button.primary-btn,
.tpl-bar button.tpl-chip,
.tpl-bar button.skill-trigger {
  display: inline-flex !important;
  flex-direction: row !important;
  flex-wrap: nowrap !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 6px !important;
  white-space: nowrap !important;
  word-break: keep-all !important;
  writing-mode: horizontal-tb !important;
  height: 28px !important;
  line-height: 1 !important;
  padding: 0 10px !important;
  box-sizing: border-box !important;
  vertical-align: middle !important;
}

.tpl-bar button.ghost-btn > svg,
.tpl-bar button.primary-btn > svg,
.tpl-bar button.skill-trigger > svg,
.tpl-bar button.ghost-btn > .ico,
.tpl-bar button.primary-btn > .ico,
.tpl-bar button.ghost-btn > .ico-svg,
.tpl-bar button.primary-btn > .ico-svg {
  display: inline-block !important;
  width: 14px !important;
  height: 14px !important;
  flex: 0 0 14px !important;
  margin: 0 !important;
  padding: 0 !important;
  vertical-align: middle !important;
  stroke: currentColor !important;
  fill: none !important;
}

.tpl-bar button.ghost-btn > span,
.tpl-bar button.primary-btn > span,
.tpl-bar button.skill-trigger > span {
  display: inline-block !important;
  flex: 0 0 auto !important;
  white-space: nowrap !important;
  line-height: 1 !important;
  margin: 0 !important;
  padding: 0 !important;
}

.tpl-bar button.ghost-btn,
.tpl-bar button.primary-btn,
.tpl-bar button.skill-trigger {
  display: inline-flex !important;
  flex-direction: row !important;
  flex-wrap: nowrap !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 6px !important;
  width: auto !important;
  min-width: auto !important;
  max-width: none !important;
  height: 28px !important;
  white-space: nowrap !important;
  overflow: visible !important;
  box-sizing: border-box !important;
  padding: 0 10px !important;
  line-height: 1 !important;
}

.tpl-bar button.ghost-btn > *,
.tpl-bar button.primary-btn > *,
.tpl-bar button.skill-trigger > * {
  display: inline-flex !important;
  flex-direction: row !important;
  flex-wrap: nowrap !important;
  align-items: center !important;
  justify-content: center !important;
  width: auto !important;
  height: auto !important;
  margin: 0 !important;
  padding: 0 !important;
  flex-shrink: 0 !important;
  white-space: nowrap !important;
  vertical-align: middle !important;
  line-height: 1 !important;
}

.tpl-bar button.ghost-btn > svg,
.tpl-bar button.primary-btn > svg,
.tpl-bar button.skill-trigger > svg {
  width: 14px !important;
  height: 14px !important;
  flex: 0 0 14px !important;
  stroke: currentColor !important;
  fill: none !important;
}

.tpl-bar button.ghost-btn > span,
.tpl-bar button.primary-btn > span,
.tpl-bar button.skill-trigger > span {
  display: inline-block !important;
  flex: 0 0 auto !important;
  width: auto !important;
  white-space: nowrap !important;
  color: inherit !important;
  font-size: 12px !important;
}

.tpl-bar .niuma-toggle input {
  accent-color: var(--primary);
  cursor: pointer;
  margin: 0;
}

.tpl-chip {
  padding: 2px 8px !important;
  font-size: 11px !important;
}

.tpl-bar {
  padding: 5px 12px !important;
  gap: 4px !important;
}

.primary-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border: 0;
  border-radius: var(--radius-6);
  font-size: var(--font-12);
  font-weight: 500;
  cursor: pointer;
  transition: 0.12s;
  color: #fff;
}

.primary-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.primary-btn .ico {
  font-size: var(--font-10);
  line-height: 1;
}

.primary-btn.head-run {
  padding: 5px 14px;
  font-size: var(--font-12);
  font-weight: 600;
}

.primary-btn.ghost {
  background: transparent;
  color: var(--text-2);
  border: 1px solid var(--border-2);
  box-shadow: none;
}

.primary-btn.ghost:hover:not(:disabled) {
  color: var(--primary);
  border-color: var(--primary);
  background: var(--primary-bg);
}

.ghost-btn {
  padding: 4px 10px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-6);
  color: var(--text-2);
  font-size: var(--font-12);
  cursor: pointer;
  transition:
    background 0.12s ease,
    color 0.12s ease,
    border-color 0.12s ease;
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 6px;
  white-space: nowrap;
  width: auto;
  min-width: auto;
  flex-wrap: nowrap;
}

.primary-btn .ico-svg {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  display: inline-block;
  vertical-align: -1px;
}

.primary-btn .ico-svg + span {
  margin-left: 2px;
}

.ghost-btn:hover:not(:disabled) {
  background: rgb(255 255 255 / 6%);
  color: var(--text);
  border-color: rgb(255 255 255 / 8%);
}

.ghost-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.primary-btn.run {
  background: transparent;
  color: var(--primary);
  border: 1px solid var(--primary);
  box-shadow: none;
}

.primary-btn.takeover {
  background: transparent;
  color: var(--primary);
  border: 1px solid var(--primary);
  box-shadow: none;
  font-weight: 600;
  border-color: var(--primary);
}

.primary-btn.stop {
  background: transparent;
  color: #f0abfc;
  border: 1px solid #f0abfc;
  box-shadow: none;
  font-weight: 600;
  border-color: #f0abfc;
}

.primary-btn.takeover:hover:not(:disabled) {
  background: rgb(88 166 255 / 14%);
  color: var(--primary-hover);
  border-color: var(--primary-hover);
  box-shadow: 0 0 0 3px rgb(88 166 255 / 10%);
}

.primary-btn.stop:hover:not(:disabled) {
  background: rgb(88 166 255 / 14%);
  color: var(--primary-hover);
  border-color: var(--primary-hover);
}

.ghost-btn > .ico-svg,
.ghost-btn > svg {
  display: inline-block;
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  margin: 0;
  vertical-align: middle;
  fill: none;
  stroke: currentColor;
}

.ghost-btn > span {
  display: inline-block;
  white-space: nowrap;
}

/* [toolbar-btn-polish] 工具栏按钮统一视觉：尺寸对齐 + 主次层级 + 交互反馈 */
.tpl-bar button.primary-btn,
.tpl-bar button.ghost-btn {
  height: 30px;
  padding: 0 12px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  line-height: 1;
  transition:
    background 0.15s,
    color 0.15s,
    border-color 0.15s,
    box-shadow 0.15s,
    transform 0.08s;
  white-space: nowrap;
}
.tpl-bar button.primary-btn > svg,
.tpl-bar button.ghost-btn > svg {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

/* 运行：实心主色 */
.tpl-bar button.primary-btn.takeover {
  background: var(--primary, #3b82f6);
  border: 1px solid var(--primary, #3b82f6);
  color: #fff;
  box-shadow: 0 1px 2px rgb(0 0 0 / 25%);
}
.tpl-bar button.primary-btn.takeover:hover:not(:disabled) {
  background: var(--primary-hover, #60a5fa);
  border-color: var(--primary-hover, #60a5fa);
  color: #fff;
  box-shadow: 0 4px 12px rgb(88 166 255 / 35%);
  transform: translateY(-1px);
}
.tpl-bar button.primary-btn.takeover:active:not(:disabled) {
  transform: translateY(0);
  box-shadow: 0 1px 2px rgb(0 0 0 / 30%);
}

/* 暂停：品红描边 */
.tpl-bar button.primary-btn.stop {
  background: transparent;
  border: 1px solid #f0abfc;
  color: #f0abfc;
  box-shadow: none;
}
.tpl-bar button.primary-btn.stop:hover:not(:disabled) {
  background: rgb(240 171 252 / 14%);
  border-color: #f5c6ff;
  color: #f5c6ff;
  box-shadow: 0 0 0 3px rgb(240 171 252 / 12%);
}

/* 清空：次要描边 */
.tpl-bar button.ghost-btn {
  background: transparent;
  border: 1px solid var(--border, #2a2d36);
  color: var(--fg-2, #b6b8bf);
}
.tpl-bar button.ghost-btn:hover:not(:disabled) {
  background: rgb(255 255 255 / 6%);
  border-color: var(--border-hover, #3a3d46);
  color: var(--fg-1, #e6e7ea);
}
.tpl-bar button.ghost-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 牛马：胶囊式开关，选中绿色 */
.tpl-bar .niuma-toggle {
  height: 30px;
  padding: 0 12px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  border: 1px solid var(--border, #2a2d36);
  background: transparent;
  color: var(--fg-2, #b6b8bf);
  cursor: pointer;
  transition:
    background 0.15s,
    color 0.15s,
    border-color 0.15s;
}
.tpl-bar .niuma-toggle:hover {
  background: rgb(255 255 255 / 6%);
  color: var(--fg-1, #e6e7ea);
}
.tpl-bar .niuma-toggle:has(input:checked) {
  background: rgb(74 222 128 / 12%);
  border-color: rgb(74 222 128 / 45%);
  color: #4ade80;
}

/* 键盘焦点环 */
.tpl-bar button.primary-btn:focus-visible,
.tpl-bar button.ghost-btn:focus-visible,
.tpl-bar .niuma-toggle:focus-visible {
  outline: 2px solid var(--primary, #3b82f6);
  outline-offset: 2px;
}

/* [dsh-theme-toolbar-v1] 底部控制条对齐 dsh dock */
.primary-btn {
  border-radius: 999px;
  background: var(--dsw-specific-input-major, var(--bg-2, rgba(127, 127, 127, 0.05)));
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.2));
  color: var(--dsw-alias-label-primary, inherit);
  transition:
    background 120ms ease,
    border-color 120ms ease;
}
.primary-btn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.08));
}
.primary-btn.head-run,
.primary-btn.run {
  background: var(--dsw-alias-state-business-primary, #4176e6);
  color: #fff;
  border-color: transparent;
}
.primary-btn.head-run:hover:not(:disabled),
.primary-btn.run:hover:not(:disabled) {
  filter: brightness(1.05);
}
.primary-btn.stop {
  background: rgb(242 90 90 / 12%);
  color: rgb(236, 19, 19);
  border-color: transparent;
}

/* [decision-in-header-v1] 决策开关与模板条同行对齐 */
.tpl-dps {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 4px;
}
</style>
