<script setup lang="ts">
// [ui-p2c-render-probe-v1] V9 验收①：dev-only 渲染打点（生产 enabled() 早退）
import { computed, nextTick, onMounted, onUpdated, ref, watch } from 'vue'
import { probeRender } from '../../composables/ui/render-probe'
import { ansiToHtml } from '../../utils/ansi-render'
import { denoiseOutput, unfoldEscapedLog } from '../../utils/timeline-preview'
// [script-card-split-v1] 从 TerminalPane 拆出的脚本卡片子组件
// [WHY] TerminalPane 行数超架构红线上限；卡片是最大块，可自持展开状态，优先独立
// [CHANGE-IMPACT] TerminalPane 的 script 分支改为 <ScriptCard :card="card" />；样式随迁

interface CardData {
  key: string
  phaseClass: string
  desc: string
  timeLabel: string
  // [card-duration-v1] 本轮执行耗时（ms）；运行中为 null
  durationMs: number | null
  why: string
  // [script-card-reason-v1] 失败原因（payload.reason）；空串=无（成功态恒为空）
  reason: string
  // [timeline-denoise-v1] 结果摘要：仅终态事件带值（运行中为 null / 0）
  exit: number | null
  changeCount: number
  // [script-card-changes-v1] 本次执行变更文件列表（供展开区显示）
  changes: Array<{ path: string, type: string }>
  // [timeline-denoise-v1] 原始输出已由 TerminalPane 折叠为尾部若干行；省略量显式标注
  stdoutText: string
  stdoutHidden: number
  stderrText: string
  stderrHidden: number
}

// [script-card-changes-v1] 点击变更文件 → 冒泡给父组件打开预览浮层
const emit = defineEmits<{ preview: [path: string] }>()

const props = withDefaults(defineProps<{ card: CardData, liveStdout?: string }>(), { liveStdout: '' })

// 展开状态下沉到卡片内；父组件不再需要 expandedCards 集合
const expanded = ref(false)
const outScrollRef = ref<HTMLElement | null>(null)
const atBottom = ref(true)

const fullOutput = computed(() => props.liveStdout || props.card.stdoutText)
/** 输出区 HTML（ANSI 转义安全着色）；[ansi-render-v1] 内容先转义再注入色标签 */
/** [output-denoise-v1] 输出区渲染：先展开 JSON 转义串（liveStdout 流式路径的原始文本未经
 *   TerminalPane 预处理，字面量 \n / \u001b 会在此原样上屏），再降噪（保 SGR），再转色 */
const cleanedOutput = computed(() => denoiseOutput(unfoldEscapedLog(fullOutput.value)))
const outputHtml = computed(() => ansiToHtml(cleanedOutput.value))
const isRunning = computed(() => props.card.phaseClass === 'phase-running')
const lineCount = computed(() => (cleanedOutput.value ? cleanedOutput.value.split('\n').length : 0))
// [scriptcard-hasbody-computed-v1] 报告 §5.1.4：模板内 hasBody 出现 4 次，每渲染重算。
// 改为 computed：仅当 card 引用变化时重算一次。
// [script-card-head-v2] why 已移出 hasBody —— 它现在常显在头部（见模板），不再需要展开。
//   于是「▸ 折叠箭头」只在真有 stdout/stderr 的步骤上出现，不再几乎每行都长一个。
// [script-card-changes-v1] 展开条件改为「有变更文件 或 有 stderr」：
//   stdout 里的 ✓ ok(...) 打点是噪音，成功无变更的步骤不应长出可点开的箭头。
const hasBody = computed(() => props.card.changes.length > 0 || Boolean(props.card.stderrText) || Boolean(fullOutput.value))
// [script-card-l3-v1] L2 折叠区是否有内容：why / 失败原因。全空则不渲染折叠区，避免空箭头。
// [sc-meta-dedupe-v1] 耗时行已从 L2 移除（只在展开区元信息栏出现），durationMs 不再参与判空
// [script-card-reason-v1] reason 参与 L2 判空：失败态即使无 why，也必须能展开看到失败原因
const hasL2 = computed(() => Boolean(props.card.why) || Boolean(props.card.reason))
// [timeline-denoise-v1] 结果摘要只在终态出现，运行中 / 等待中不占位
const isFinal = computed(() => props.card.phaseClass === 'phase-done' || props.card.phaseClass === 'phase-error')
const isFailed = computed(() => props.card.phaseClass === 'phase-error')
/**
 * 结果徽标文案
 * [WHY] 用户对一步操作的第一疑问是「成了没、动了什么」，其次才是原始输出；
 *   失败给退出码，成功给变更文件数（0 也明示「无改动」，避免误以为漏看）
 */
const resultLabel = computed(() => {
  if (!isFinal.value) return ''
  if (isFailed.value) return props.card.exit === null ? '' : `exit ${props.card.exit}`
  return props.card.changeCount > 0 ? String(props.card.changeCount) : ''
})
/** 结果徽标配色类：失败红、有变更主色、无改动弱化 */
/** [card-duration-v1] 耗时文案：<1s 显示 ms，否则显示秒 */
const durLabel = computed(() => {
  const ms = props.card.durationMs
  if (ms == null) return ''
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`
})
const resultClass = computed(() => {
  if (isFailed.value) return 'stat-fail'
  return props.card.changeCount > 0 ? 'stat-changed' : 'stat-none'
})

watch(fullOutput, async () => {
  // [output-autoscroll-v1] 贴底才自动跟随；上滑后不抢视线（点「回到底部」恢复）
  if (!atBottom.value) return
  await nextTick()
  const el = outScrollRef.value
  if (el) el.scrollTop = el.scrollHeight
})

// [ui-p2c-render-probe-v1] mount/update 各打一次；判据①用 update delta 算单事件重渲染卡数
onMounted(() => probeRender(`sc:${props.card.key}`, 'mount'))
onUpdated(() => probeRender(`sc:${props.card.key}`, 'update'))

function onOutScroll(): void {
  const el = outScrollRef.value
  if (!el) return
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 30
}
function jumpBottom(): void {
  const el = outScrollRef.value
  if (!el) return
  el.scrollTop = el.scrollHeight
  atBottom.value = true
}
function toggle(): void { expanded.value = !expanded.value }
</script>

<template>
  <div :id="`card-${card.key}`" class="script-card" :class="[card.phaseClass, { 'is-expanded': expanded }]">
    <!-- [ui-kbd-a11y-v1] 可点击头补键盘可达（WO-20261007-02 阶段 C5）：
         role/tabindex 仅在 hasBody 时生效；Enter/Space 等价于点击。 -->
    <div
      class="script-card-head"
      :class="{ 'is-clickable': hasBody }"
      :role="hasBody ? 'button' : undefined"
      :tabindex="hasBody ? 0 : undefined"
      :aria-expanded="hasBody ? expanded : undefined"
      @click="hasBody ? toggle() : null"
      @keydown.enter.prevent="hasBody ? toggle() : null"
      @keydown.space.prevent="hasBody ? toggle() : null"
    >
      <!-- [sc-phase-style-v1] 阶段图标（4 态）；phase 类下沉到 span 以便色选择器命中 -->
      <span class="script-card-phase" :class="card.phaseClass" aria-hidden="true">
        <svg v-if="card.phaseClass === 'phase-done'" class="phase-icon" viewBox="0 0 20 20">
          <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.8" />
          <path d="M6.5 10.3 L9 12.7 L13.5 7.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <svg v-else-if="card.phaseClass === 'phase-error'" class="phase-icon" viewBox="0 0 20 20">
          <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.8" />
          <path d="M7 7 L13 13 M13 7 L7 13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
        <svg v-else-if="card.phaseClass === 'phase-running'" class="phase-icon phase-icon-spin" viewBox="0 0 20 20">
          <g stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <line x1="10" y1="1.5" x2="10" y2="4" opacity="0.25" />
            <line x1="10" y1="16" x2="10" y2="18.5" opacity="0.85" />
            <line x1="1.5" y1="10" x2="4" y2="10" opacity="0.35" />
            <line x1="16" y1="10" x2="18.5" y2="10" opacity="0.7" />
            <line x1="4" y1="4" x2="5.8" y2="5.8" opacity="0.3" />
            <line x1="14.2" y1="14.2" x2="16" y2="16" opacity="0.95" />
            <line x1="16" y1="4" x2="14.2" y2="5.8" opacity="0.5" />
            <line x1="5.8" y1="14.2" x2="4" y2="16" opacity="0.6" />
          </g>
        </svg>
        <svg v-else class="phase-icon" viewBox="0 0 20 20">
          <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="2 2.5" />
        </svg>
      </span>
      <!-- [script-card-head-v2] 文本区两行：① desc = 这一步做了什么；② why = 为什么做。
           两者都常显（why 原先藏在展开区，等于要求用户逐行点开才懂意图）；
           都是单行省略号 + 溢出才提示 ⇒ 头部高度可预期（≤3 行）且裁掉的全文随时可查。 -->
      <span class="script-card-main">
        <!-- L1 常显：只留 desc（这一步做了什么）+ 右侧状态摘要，保证每行高度稳定 -->
        <span class="script-card-l1">
          <span v-overflow-tip="card.desc" class="script-card-desc">{{ card.desc }}</span>
          <span v-if="resultLabel" class="script-card-stat" :class="resultClass">{{ resultLabel }}</span>
          <span class="script-card-time">{{ card.timeLabel }}</span>
        </span>
        <!-- L2 折叠：why / 失败原因。耗时与行数只在展开区元信息栏出现一次（[sc-meta-dedupe-v1]） -->
        <span v-if="expanded && hasL2" class="script-card-l2">
          <span v-if="card.why" class="script-card-why">
            <span v-overflow-tip="card.why" class="why-text">{{ card.why }}</span>
          </span>
          <span v-if="card.reason" class="script-card-reason">
            <span class="reason-label">失败原因</span>
            <span v-overflow-tip="card.reason" class="reason-text">{{ card.reason }}</span>
          </span>
        </span>
        <!-- [card-info-converge-v1] 原此处的 stat 兜底渲染与 L1 重复，已删除：状态徽标只在 L1 出现一次。 -->
      </span>
    </div>
    <!-- [script-card-head-v2] 展开区只剩原始输出（why 已上提到头部）：
         有输出的步骤才配折叠箭头，不再是「几乎每行都能点开、点开只有一段复述」。 -->
    <div v-if="expanded && hasBody" class="script-card-tail">
      <!-- [script-card-detail-v1] 展开区先给一行元信息（状态 / 耗时 / 输出行数 / 退出码），
           头部只留 desc + 状态点 + 时间，信息密度上移到这里，避免折叠态噪音。 -->
      <div class="tail-meta">
        <span v-if="isFailed" class="tail-meta-item is-fail">{{ card.exit === null ? '执行失败' : `退出码 ${card.exit}` }}</span>
        <span v-if="card.durationMs != null" class="tail-meta-item">耗时 {{ durLabel }}</span>
        <span v-if="lineCount" class="tail-meta-item">{{ lineCount }} 行输出</span>
        <span v-if="card.changeCount" class="tail-meta-item">{{ card.changeCount }} 文件变更</span>
      </div>
      <div v-if="fullOutput" class="sc-out">
        <!-- eslint-disable-next-line vue/no-v-html -- ansiToHtml 已严格转义，仅注入白名单色 span -->
        <pre ref="outScrollRef" class="sc-out-scroll" @scroll.passive="onOutScroll"><span v-html="outputHtml" /><span v-if="isRunning" class="sc-cursor" aria-hidden="true">█</span></pre>
        <button v-if="!atBottom" class="sc-jump" @click="jumpBottom">
          ↓ 回到底部
        </button>
        <!-- [sc-meta-dedupe-v1] 底栏不再重复行数/耗时（与展开区元信息栏三处重复已收敛为一处）；
             仅运行中保留状态提示 -->
        <div v-if="isRunning" class="sc-out-bar">
          <span class="sc-running">运行中…</span>
        </div>
      </div>
      <!-- [script-card-changes-v1] 变更文件列表：点击打开预览浮层（由父组件承接） -->
      <ul v-if="card.changes.length" class="tail-files" role="list">
        <li v-for="c in card.changes" :key="c.path" class="tail-file">
          <button
            class="tail-file-btn"
            type="button"
            :aria-label="`预览 ${c.path}`"
            @click.stop="emit('preview', c.path)"
          >
            <span class="tail-file-status" :class="`st-${c.type}`">{{ c.type === 'added' ? 'A' : c.type === 'deleted' ? 'D' : 'M' }}</span>
            <span class="tail-file-path">{{ c.path }}</span>
          </button>
        </li>
      </ul>
      <!-- [timeline-denoise-v1] 有 stderr 时才展示：失败信息是必看内容，正常输出不上屏 -->
      <div v-if="card.stderrHidden > 0" class="tail-omitted">
        ⋯ 前 {{ card.stderrHidden }} 行已省略
      </div>
      <pre v-if="card.stderrText" class="tail-pre err">{{ card.stderrText }}</pre>
    </div>
  </div>
</template>

<style scoped>
.script-card {
  position: relative;
  margin: 0 0 2px;
  padding: 5px 0 5px 10px;
  border: 0;
  background: transparent;
  border-radius: 8px;
  transition: background-color 0.14s ease;
}
/* [sc-drop-left-bar-v1] 移除左侧 2px 状态色条（用户指定：图标左侧竖线干扰视线）；
   成功/失败语义仍由阶段图标颜色 + 状态徽标承载，信息不丢失。 */
/* [card-bg-on-expand-v1] 展开时显示背景（替代 hover 变色，避免与头部 hover 叠成两层） */
/* [card-info-converge-v1] 展开态不再整块铺灰底（与左色条、hover 叠加后浑浊），
   改为极淡描边标示「这块是展开的」。 */
.script-card.is-expanded {
  background: transparent;
  box-shadow: inset 0 0 0 1px rgba(127, 127, 127, 0.14);
}
/* [ui-codex-align-v1] 4px 网格：gap 6→8、margin 2→4；层级靠灰度不靠色块 */
.script-card-head {
  display: flex;
  /* [script-card-head-v2] 顶部对齐：图标/徽章/时间都挂在 desc 那一行上，纵向扫读更稳。 */
  align-items: flex-start;
  gap: 8px;
  /* [card-info-converge-v1] 横向内边距 8 → 4：卡片本体已有 10px 左内边距，
     再叠 8 会让 desc 起点离色条过远；行高 16 → 18 给 13px 主信息留呼吸。 */
  padding: 3px 4px;
  border-radius: 6px;
  font-size: var(--font-11);
  line-height: 18px;
  color: var(--text-3, #8b949e);
}
.script-card-head.is-clickable {
  cursor: pointer;
  user-select: none;
}
.script-card-head.is-clickable:hover {
  background: rgba(127, 127, 127, 0.06);
}
.script-card-head.is-clickable::after {
  content: '▸';
  margin-left: 4px;
  /* [ui-type-scale-v1] 9px 低于下限，上调 11px */
  font-size: var(--font-11);
  color: var(--text-3, #8b949e);
  opacity: 0.6;
  transition: transform 0.15s ease;
}
.script-card-head.is-clickable[aria-expanded='true']::after {
  transform: rotate(90deg);
}
/* [script-card-compact-v1] 时间不再独占一行：跟随状态徽标成组，靠 head 的 gap 控制间距 */
.script-card-time {
  flex: 0 0 auto;
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 10.5px;
  font-weight: 400;
  color: var(--text-3, #8b949e);
  /* [card-info-converge-v1] 时间只在需要精确定位时才有价值，默认淡到近乎背景。 */
  opacity: 0.45;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.2px;
}
/* [script-card-head-v2] 文本区（列方向）：① desc ② why ③ 失败原因，
   整体吃掉 head 的剩余宽度（原 desc 的 flex:1 职责上移到这里）。 */
.script-card-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
/* [script-card-l3-v1] L1：desc + 结果摘要同一行，常驻可见；L2 缩进在其下方，仅展开时出现 */
/* [card-info-converge-v1] L1 一行三类信息：desc 吃满剩余宽度成为主信息，
   状态徽标与时间整体靠右成组（margin-left:auto），视觉上退为附属。 */
.script-card-l1 {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.script-card-l1 > .script-card-desc {
  flex: 1 1 auto;
}
.script-card-l1 > .script-card-stat,
.script-card-l1 > .script-card-time {
  flex: 0 0 auto;
}
.script-card-l1 > .script-card-stat:first-of-type {
  margin-left: auto;
}
.script-card-l2 {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  padding-left: 2px;
  border-left: 2px solid var(--border-1, #30363d);
  margin-top: 1px;
}
/* [script-card-head-v2] desc 现在是列容器的第一行，必须显式 block + width:100% + min-width:0，
   否则列容器下不会收缩，省略号（ellipsis）根本不会出现 —— 这是 flex 纵向布局的常见坑。 */
.script-card-desc {
  display: block;
  width: 100%;
  min-width: 0;
  /* [card-info-converge-v1] desc 是每张卡片唯一的视觉焦点：提亮到 text-1、
     字号 13px、字重 450；状态徽标与时间整体降到 11px 次级色，避免三者平权抢读。 */
  color: var(--text-1, #e6edf3);
  font-size: 13px;
  font-weight: 450;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* [timeline-denoise-v1] 结果摘要徽标：desc 弹性占满后自然靠右，与时间标签成组 */
/* [ui-codex-align-v1] 徽章降噪：色块→色点+文字；状态语义只由 6px 圆点承载 */
.script-card-stat {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font: 400 10.5px/16px var(--mono, ui-monospace, monospace);
  white-space: nowrap;
  /* [card-info-converge-v1] 徽标只作状态备注，默认半透明；hover 卡片时才浮出完整亮度。 */
  opacity: 0.8;
}
.script-card:hover .script-card-stat {
  opacity: 1;
}
.script-card-stat::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: currentcolor;
  flex: 0 0 auto;
}
.script-card-stat.stat-changed {
  color: var(--primary, #58a6ff);
}
.script-card-stat.stat-fail {
  color: var(--danger, #f85149);
}
.script-card-stat.stat-none {
  color: var(--text-3, #8b949e);
  opacity: 0.75;
}
/* [script-card-head-v2] why / 失败原因两行：常显的次要信息。
   标签不占色块（每行都出现的带底色 pill 会形成视觉噪音），只用等宽小字 + 低对比做区分。 */
.script-card-why,
.script-card-reason {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  line-height: 1.35;
}
/* [sc-drop-why-label-v1] WHY 字样标签已移除（用户指定）：why 文本自身即说明用途，
   只保留「失败原因」标签——它是用户意想不到的内容，需要显式标注。 */
.reason-label {
  flex: 0 0 auto;
  font-family: var(--mono, ui-monospace, monospace);
  /* [ui-type-scale-v1] 辅助下限 11px */
  font-size: var(--font-11);
  font-weight: 400;
  letter-spacing: 0.5px;
  color: var(--text-3, #8b949e);
  opacity: 0.7;
}
.reason-label {
  color: var(--danger, #f85149);
  opacity: 0.9;
}
.why-text,
.reason-text {
  flex: 1 1 auto;
  min-width: 0;
  /* [desc-why-legibility-v1] 允许两行：why / reason 是完整句子，单行省略后只能 hover 才能读全，
     而这两行的价值正是「一眼看懂意图 / 失败原因」。头部高度仍可预期（≤4 行）。 */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  white-space: normal;
  overflow: hidden;
  text-overflow: ellipsis;
}
.why-text {
  color: var(--text-3, #8b949e);
}
.reason-text {
  color: var(--danger, #f85149);
}
/* [script-card-detail-v1] 展开区元信息栏：紧凑一行，弱色，失败项才着色 */
.tail-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
  margin-bottom: 6px;
  font: 400 11px/1.4 var(--mono, ui-monospace, monospace);
  color: var(--text-3, #8b949e);
  opacity: 0.85;
}
.tail-meta-item.is-fail {
  color: var(--danger, #f85149);
  opacity: 0.9;
}
/* 展开后的失败原因：允许三行，比折叠态更详细 */
.tail-reason {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 6px;
  line-height: 1.45;
}
.tail-reason .reason-text {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  white-space: normal;
  overflow: hidden;
}
/* [sc-tail-scroll-v1] 去掉外层 max-height/overflow：与 .sc-out-scroll 嵌套滚动冲突；输出区自理滚动 */
.script-card-tail {
  margin-top: 8px;
  padding: 8px;
  border-top: 1px dashed var(--border, #30363d);
}
.script-card-tail .tail-pre {
  margin: 0;
  padding: 2px 0;
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2, #c9d1d9);
  white-space: pre-wrap;
  word-break: break-word;
  tab-size: 2;
}
.script-card-tail .tail-pre.err {
  color: var(--danger, #ef4444);
}
/* [timeline-denoise-v1] 省略提示：说明卡片只保留了尾部内容，避免用户以为输出只有这几行 */
.script-card-tail .tail-omitted {
  padding: 1px 0 3px;
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-3, #8b949e);
  opacity: 0.7;
}

/* [sc-phase-style-v1] 阶段色与图标；选择器改为 .script-card-phase.phase-*，避免依赖父节点链 */
.script-card-phase {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  /* [script-card-head-v2] 14px 图标在 17.6px 的 desc 行里光学居中（(17.6-14)/2 ≈ 1.8px） */
  margin-top: 2px;
  color: var(--text-3, #8b949e);
}
.script-card-phase.phase-running {
  color: var(--primary, #58a6ff);
}
.script-card-phase.phase-pending {
  color: var(--warning, #d29922);
}
.script-card-phase.phase-done {
  color: var(--success, #3fb950);
}
.script-card-phase.phase-error {
  color: var(--danger, #f85149);
}
.phase-icon {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
  display: block;
}
.phase-icon-spin {
  animation: phase-spin 1.6s linear infinite;
}
@keyframes phase-spin {
  to {
    transform: rotate(360deg);
  }
}

/* [sc-full-output-v1] 完整输出面板 */
.script-card-tail .sc-out {
  position: relative;
  margin: 6px 0 4px;
  border-radius: 8px;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.22);
  border: 1px solid rgba(127, 127, 127, 0.15);
}
/* [sc-out-theme-v1] 亮色下改浅灰凹陷，避免黑块 */
[data-theme='light'] .script-card-tail .sc-out {
  background: rgba(0, 0, 0, 0.035);
  border-color: rgba(0, 0, 0, 0.1);
}
.script-card-tail .sc-out-scroll {
  max-height: 240px;
  overflow-y: auto;
  padding: 10px 12px;
  margin: 0;
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-2, #c9d1d9);
}
.script-card-tail .sc-out-scroll::-webkit-scrollbar {
  width: 8px;
}
.script-card-tail .sc-out-scroll::-webkit-scrollbar-thumb {
  background: rgba(127, 127, 127, 0.35);
  border-radius: 4px;
}
.script-card-tail .sc-cursor {
  display: inline-block;
  color: var(--primary, #58a6ff);
  animation: sc-blink 1s step-end infinite;
}
@keyframes sc-blink {
  50% {
    opacity: 0;
  }
}
.script-card-tail .sc-jump {
  position: absolute;
  right: 12px;
  bottom: 42px;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--primary, #58a6ff);
  color: var(--on-primary, #fff);
  border: none;
  font-size: 11px;
  cursor: pointer;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.35);
}
.script-card-tail .sc-out-bar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 6px 12px;
  background: rgba(127, 127, 127, 0.06);
  border-top: 1px solid rgba(127, 127, 127, 0.12);
  font-size: 11px;
  color: var(--text-3, #8b949e);
}
.script-card-tail .sc-out-bar .sc-running {
  color: var(--primary, #58a6ff);
}
</style>

<style scoped>
/* [script-card-changes-v1] 变更文件列表：紧凑、可点击预览 */
.tail-files {
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
}
.tail-file {
  line-height: 1.5;
}
.tail-file-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 2px 6px;
  font: 400 12px/1.5 var(--mono, monospace);
  color: var(--text-2);
  background: transparent;
  border: 0;
  border-radius: 4px;
  cursor: pointer;
  text-align: left;
}
.tail-file-btn:hover {
  background: rgb(127 127 127 / 10%);
}
.tail-file-status {
  flex: 0 0 auto;
  width: 14px;
  text-align: center;
  font-weight: 700;
}
.tail-file-status.st-added {
  color: var(--success, #3fb950);
}
.tail-file-status.st-deleted {
  color: var(--danger, #f85149);
}
.tail-file-status.st-modified {
  color: var(--warning, #d29922);
}
.tail-file-path {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* [ansi-render-v1] ANSI 16 色（暗色系适配；与终端观感一致） */
.sc-out-scroll .a-bold {
  font-weight: 600;
}
.sc-out-scroll .a-dim {
  opacity: 0.65;
}
.sc-out-scroll .a-black {
  color: #6e7681;
}
.sc-out-scroll .a-red {
  color: #f85149;
}
.sc-out-scroll .a-green {
  color: #3fb950;
}
.sc-out-scroll .a-yellow {
  color: #d29922;
}
.sc-out-scroll .a-blue {
  color: #58a6ff;
}
.sc-out-scroll .a-magenta {
  color: #bc8cff;
}
.sc-out-scroll .a-cyan {
  color: #39c5cf;
}
.sc-out-scroll .a-white {
  color: #c9d1d9;
}
.sc-out-scroll .a-bright-black {
  color: #8b949e;
}
.sc-out-scroll .a-bright-red {
  color: #ff7b72;
}
.sc-out-scroll .a-bright-green {
  color: #56d364;
}
.sc-out-scroll .a-bright-yellow {
  color: #e3b341;
}
.sc-out-scroll .a-bright-blue {
  color: #79c0ff;
}
.sc-out-scroll .a-bright-magenta {
  color: #d2a8ff;
}
.sc-out-scroll .a-bright-cyan {
  color: #56d4dd;
}
.sc-out-scroll .a-bright-white {
  color: #f0f6fc;
}
</style>
