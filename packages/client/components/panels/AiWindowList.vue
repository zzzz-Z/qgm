<script setup lang="ts">
import { TOAST_MEDIUM, TOAST_SHORT_MEDIUM } from '../../utils/toast-durations'
// [win-sid-namespace-v1] 站点窗口槽位 sid 用共享命名来源（与 App.vue 开窗路径一致）
import { isWindowMarkedOpened, markWindowOpened, probeWindowBySid, winSidOf } from '../../composables/ai/useAiWindowTable'
// [defensive-refresh-v1] 跨域窗口无 close 事件可监听，只能轮询兜底；
// 但仅在前台标签页轮询，后台标签页无需刷新列表可显著降低 CPU。
// [CONSTRAINT] visibilitychange 时立即补一次 windowsTick，保证切回前台马上同步。
const _pollEnabled = ref(typeof document !== 'undefined' ? document.visibilityState === 'visible' : true)

// @desc 左侧常驻 AI 站点面板：固定展示 MODELS 全列表，每站点单窗口单激活
// @why  用户需求"显示固定网站 + 每网站只允许一个激活会话"；
//       用固定 sid `win_${model.id}` 与 openSite 的 windowName 复用机制配合，保证同站点单窗口
// @change-impact 依赖 MODELS 常量与 useAiWindowTable 的响应式信号；
//                与主流程（useSessionManager 随机 sid）并存，两者互不覆盖
// [sites-persist-v1] 点击站点需持久化 modelId（刷新不丢 + 上方 URL 同步）

const { toast } = useToast()
// [sites-persist-v1] 读取当前站点 modelId（持久化态）用于高亮与刷新恢复
// [sites-highlight-v1] 读取持久化 modelId，刷新后仍能高亮当前站点
const { modelId, setModel } = useAiSite()
useIntervalFn(() => { if (_pollEnabled.value) windowsTick.value++ }, 1500, { immediate: true })

/** 站点列表（MODELS 全量）→ 附加运行时状态（opened / active） */
// [aiwin-list-no-self-write-v1] 报告 §3 P2：原实现 computed 内调 listWindows() 会触发 bumpWindows()
// 写 windowsTick（computed 自己的依赖）→ 每次求值都令自身失效，构成隐藏的响应式环。
// 改为：丢弃返回值、仅用作清理死窗口的副作用；其内部 bump 会通过 tick 触发下一轮 recompute 收敛。
const items = computed(() => {
  void windowsTick.value
  listWindows()
  const active = getActiveWinSid()
  return MODELS.map((m) => {
    const sid = winSidOf(m.id)
    const win = getWindowBySid(sid)
    return {
      id: m.id,
      label: m.label,
      url: m.url,
      sid,
      opened: Boolean(win),
      // [sites-highlight-v1] 刷新后窗口表为空，改以持久化 modelId 为主判据；内存窗口激活作为兜底
      // [WHY] 原判据 sid === active && Boolean(win) 依赖内存窗口表，刷新即丢高亮
      // [CHANGE-IMPACT] 用户点击 / setModel 后立即高亮，与上方 URL 保持一致
      active: m.id === modelId.value || (sid === active && Boolean(win)),
    }
  })
})
/** 已激活数（用于头部角标） */
const openedCount = computed(() => items.value.filter(it => it.opened).length)

// [win-opened-marker-v1] 挂载时探测一次（无标记时不做任何探测，无副作用）
onMounted(() => { probeAllMarked() })

if (typeof document !== 'undefined') {
  const onVis = () => {
    _pollEnabled.value = document.visibilityState === 'visible'
    if (!_pollEnabled.value) return
    // [win-opened-marker-v1] 切回前台校正：用户手动关窗后无需刷新即降级
    probeAllMarked()
  }
  onMounted(() => document.addEventListener('visibilitychange', onVis))
  onBeforeUnmount(() => document.removeEventListener('visibilitychange', onVis))
}

/**
 * [win-opened-marker-v1] 探测所有已标记 sid：
 * 标记存在 → `window.open('', name)` 拿回引用（同源 about:blank 会被 close 回收）；
 * 探测成功写回 windowTable，opened 判据即有真值；探测失败自动清标记（用户关窗场景纠偏）。
 * [CONSTRAINT] MODELS 数量小（个位数），一次全探；单个失败不阻断其他站点。
 */
function probeAllMarked(): void {
  if (typeof window === 'undefined') return
  for (const m of MODELS) {
    const sid = winSidOf(m.id)
    if (!isWindowMarkedOpened(sid)) continue
    try { probeWindowBySid(sid) } catch { /* 单个失败不阻断 */ }
  }
  windowsTick.value++
}
/**
 * 点击某站点：
 * - 已开窗口 → 激活切换
 * - 未开窗口 → openSite(url, sid) 打开；成功则激活
 */
async function onClick(item: { id: string, label: string, url: string, sid: string, opened: boolean }): Promise<void> {
  // [sites-persist-v1] 无论窗口是否已打开，都先把持久化 modelId 切到该站点：
  // [WHY] 只有 setModel 会写 localStorage（__ai_model_id）并同步 url；仅 setActiveWinSid 属内存态，刷新即丢
  // [CONSTRAINT] setModel 命中 MODELS 才生效；未命中返回 false，不阻断后续开窗流程
  // [CHANGE-IMPACT] App.vue 的 watch(modelId) 会随之重载会话历史 / 清 sessionId
  setModel(item.id)
  if (item.opened) {
    setActiveWinSid(item.sid)
    windowsTick.value++
    return
  }
  const win = openSite(item.url, item.sid)
  if (!win) {
    toast(`打开 ${item.label} 失败（可能被浏览器拦截弹窗）`, 'warn', TOAST_MEDIUM)
    return
  }
  setActiveWinSid(item.sid)
  windowsTick.value++
  void url
}
/** 关闭某站点窗口：仅从表中移除引用，不强制 win.close */
function dismiss(sid: string, label: string): void {
  removeWindowBySid(sid)
  // [win-opened-marker-v1] 同步清「已打开」标记：否则刷新后 sessionStorage 残留
  // 会让列表误显示「已打开」（用户关窗后重新加载工作台的场景）
  markWindowOpened(sid, false)
  windowsTick.value++
  toast(`已移除 ${label} 的窗口引用`, 'info', TOAST_SHORT_MEDIUM)
}
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
  flex: 0 0 250px;
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
  /* [ui-color-token-v1] 硬编码 primary → 语义变量 */
  background: var(--primary-bg);
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
  background: rgba(127, 127, 127, 0.12);
}
/* [ui-list-v2] 未打开项降色阶：凸显已打开/激活项 */
.awl-item:not(.opened) .awl-label {
  color: var(--text-2);
}
.awl-item:not(.opened) .awl-sub {
  color: var(--text-3);
  opacity: 0.7;
}
/* [ui-list-v2] 激活项：竖条 + 背景加强 + 微左边距 */
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
.awl-item.opened .awl-dot {
  background: rgba(127, 127, 127, 0.55);
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
</style>
