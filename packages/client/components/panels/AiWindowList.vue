<script setup lang="ts">
// @desc 左侧常驻 AI 站点面板：固定展示 MODELS 全列表，每站点单窗口单激活
// @why  用户需求"显示固定网站 + 每网站只允许一个激活会话"；
//       用固定 sid `win_${model.id}` 与 openDeepseek 的 windowName 复用机制配合，保证同站点单窗口
// @change-impact 依赖 MODELS 常量与 useAiWindowTable 的响应式信号；
//                与主流程（useSessionManager 随机 sid）并存，两者互不覆盖
import { computed } from 'vue'
import { useIntervalFn } from '@vueuse/core'
import { MODELS, url } from '../../composables/ai/useDeepseekUrl'
import { openDeepseek } from '../../composables/ai/useAiWindow'
import { getActiveWinSid, getWindowBySid, listWindows, removeWindowBySid, setActiveWinSid, windowsTick } from '../../composables/ai/useAiWindowTable'
import { useToast } from '../../composables/ui/useToast'

const { toast } = useToast()

// [防御性刷新] 用户手动关闭窗口时 1.5s 后同步状态
useIntervalFn(() => { windowsTick.value++ }, 1500, { immediate: true })

/** 固定 sid：每站点一个稳定 id，不随会话切换变化 */
function sidOf(modelId: string): string { return `win_${modelId}` }

/** 站点列表（MODELS 全量）→ 附加运行时状态（opened / active） */
const items = computed(() => {
  void windowsTick.value
  void listWindows()
  const active = getActiveWinSid()
  return MODELS.map((m) => {
    const sid = sidOf(m.id)
    const win = getWindowBySid(sid)
    return {
      id: m.id,
      label: m.label,
      url: m.url,
      sid,
      opened: Boolean(win),
      active: sid === active && Boolean(win),
    }
  })
})

/**
 * 点击某站点：
 * - 已开窗口 → 激活切换
 * - 未开窗口 → openDeepseek(url, sid) 打开；成功则激活
 */
async function onClick(item: { id: string, label: string, url: string, sid: string, opened: boolean }): Promise<void> {
  if (item.opened) {
    setActiveWinSid(item.sid)
    windowsTick.value++
    return
  }
  const win = openDeepseek(item.url, item.sid)
  if (!win) {
    toast(`打开 ${item.label} 失败（可能被浏览器拦截弹窗）`, 'warn', 4000)
    return
  }
  setActiveWinSid(item.sid)
  windowsTick.value++
  void url
}

/** 关闭某站点窗口：仅从表中移除引用，不强制 win.close */
function dismiss(sid: string, label: string): void {
  removeWindowBySid(sid)
  windowsTick.value++
  toast(`已移除 ${label} 的窗口引用`, 'info', 2500)
}

/** 已激活数（用于头部角标） */
const openedCount = computed(() => items.value.filter(it => it.opened).length)
</script>

<template>
  <aside class="ai-window-list" aria-label="AI 站点列表">
    <header class="awl-head">
      <span class="awl-title">AI 站点</span>
      <span class="awl-count">{{ openedCount }} / {{ items.length }}</span>
    </header>
    <ul class="awl-list" role="listbox">
      <li
        v-for="w in items"
        :key="w.id"
        class="awl-item"
        :class="{ active: w.active, opened: w.opened }"
        role="option"
        :aria-selected="w.active"
        :title="w.url"
        @click="onClick(w)"
      >
        <span class="awl-dot" aria-hidden="true" />
        <div class="awl-meta">
          <span class="awl-label">{{ w.label }}</span>
          <span class="awl-sub">{{ w.opened ? (w.active ? '激活中' : '已打开') : '未打开' }}</span>
        </div>
        <button
          v-if="w.opened"
          class="awl-close"
          type="button"
          :aria-label="`移除 ${w.label}`"
          @click.stop="dismiss(w.sid, w.label)"
        >
          ×
        </button>
      </li>
    </ul>
  </aside>
</template>

<style scoped lang="scss">
.ai-window-list {
  flex: 0 0 200px;
  min-width: 160px;
  max-width: 260px;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-right: 1px solid var(--border);
  overflow: hidden;
}

.awl-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
  flex-shrink: 0;
}
.awl-title {
  flex: 1;
  letter-spacing: 0.2px;
}
.awl-count {
  padding: 1px 6px;
  font:
    600 10.5px/1.4 ui-monospace,
    monospace;
  color: var(--primary);
  background: rgba(88, 166, 255, 0.12);
  border-radius: 999px;
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
  background: rgba(127, 127, 127, 0.08);
}
.awl-item.active {
  background: rgba(88, 166, 255, 0.1);
}

.awl-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: rgba(127, 127, 127, 0.28);
  flex-shrink: 0;
}
.awl-item.opened .awl-dot {
  background: rgba(127, 127, 127, 0.55);
}
.awl-item.active .awl-dot {
  background: var(--primary, #58a6ff);
  box-shadow: 0 0 6px rgba(88, 166, 255, 0.6);
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
  font-size: 10.5px;
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
</style>
