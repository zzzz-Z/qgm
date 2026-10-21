<script setup lang="ts">
// [ui-p2c-render-probe-v1] V9 验收①：dev-only 渲染打点（生产 enabled() 早退）
import { computed, onBeforeUnmount, onMounted, onUpdated, ref, watch } from 'vue'
import { probeRender } from '../../composables/ui/render-probe'
import { useAsk } from '../../composables/ui/useAsk'
import { renderMarkdown } from '../../composables/useMarkdown'
// [round-card-v1] 从 TerminalPane 抽出：done / text / ask / question 四类非脚本卡片
// [WHY] TerminalPane 超 HCLC 500 红线；四类卡片共用 text-card 布局
// [CHANGE-IMPACT] 折叠机制已整体下线（见 [no-fold-full-text-v1]）：
//   卡片不再持有展开态，也不再有父级 expandedCards 集合 —— 四类卡片恒渲染 card.text 全文。

// [no-fold-full-text-v1] preview / truncated / hiddenLines 是折叠时代的产物：
//   上游（timeline-build.ts / TerminalPane.vue）仍在算并下发，但**不再驱动任何渲染**：
//   卡片恒渲染 card.text 全文。字段保留只为两件事：
//   ① 空内容守卫 `(card.text || card.preview).trim()` 的兼容形态（见 script-card-layout 守卫）；
//   ② 避免为摘除几个只读字段去改 4 个调用点（上游 clampTextPreview 早已是纯函数，无副作用）。
interface PreviewFields {
  text: string
  preview: string
  truncated: boolean
  hiddenLines: number
  totalLines: number
}
interface DoneCard extends PreviewFields { type: 'done', key: string, timeLabel: string }
interface TextCard extends PreviewFields { type: 'text', key: string, timeLabel: string }
interface AskCard extends PreviewFields { type: 'ask', key: string, timeLabel: string, role?: 'user-answer' }
interface QuestionCard extends PreviewFields {
  type: 'question'
  key: string
  timeLabel: string
  askId: string
  options: Array<{ id: string, label: string }>
  answered: boolean
  answer: string
}
type RoundCardData = DoneCard | TextCard | AskCard | QuestionCard

const props = defineProps<{ card: RoundCardData }>()

// [no-fold-full-text-v1] 折叠入口下线，卡片恒渲染全文。
// [WHY] 用户实测诉求（2026-10-21）：「删除展开全部 默认就全部展示」——「展开全部 · 还有 N 行」
//   这个二级交互是纯摩擦：要读完整内容得先点一次，且折叠态下还可能误以为内容就这么多。
//   中间过程的可扫读性由别的机制承担（脚本卡的尾部折叠 tailTextPreview、分段卡 RoundDivider），
//   文本卡本身就该一次给全。
// [CHANGE-IMPACT] expanded / collapsed / toggle() 一并删除；不再 import FoldToggle（组件已删）。
//   html 恒取 card.text —— 之前 collapsed 期取 card.preview 的分支是内容缺口的唯一来源。
// [CONSTRAINT] 由 tests/component-binding-guard.node-test.ts T4 与 tests/ask-card-wiring.node-test.ts
//   「卡片默认全量渲染」两条守卫：模板里再出现 <FoldToggle> / card.preview 渲染即变红。
const askDraft = ref('')
// [ask-ime-v1] 中文输入法组字保护：
//   [WHY] IME 组字期间 @input 会触发但值是拼音，此时若点「发送」会发出拼音而非汉字。
//   组字期间不更新 askDraft，compositionend 才同步最终文本。
const _imeComposing = ref(false)

const { askState, restoreAsk, answerAsk } = useAsk()

// [no-fold-full-text-v1] 恒渲染全文：不再有 collapsed ? preview : text 的分支
const html = computed(() => renderMarkdown(props.card.text))
const qCard = computed(() => props.card as QuestionCard)
const isQuestion = computed(() => props.card.type === 'question')
const isAskActive = computed(() => {
  if (!isQuestion.value) return false
  const c = qCard.value
  // [ask-active-v3] 可交互只看「卡片是否已回答」——不与全局 askState 比对。
  //   [WHY] 原判据 askState.value.id === c.askId 在 askUser 被重复调用（重放 / 多通道）时，
  //   旧卡片的 id 与最新 askState.id 不符 ⇒ 按钮永久 disabled，用户点选项无反应（实测）。
  //   [CONSTRAINT] 点击时由 submitAnswer 调 restoreAsk 抢占活跃提问，无需事先比对。
  if (c.answered) return false
  if (!c.askId) return false
  return true
})

// [ask-hotkey-v2] 只在 ASK 活跃期挂监听：失效/已回答即撤，避免长期占用全局数字键。
watch(isAskActive, (active) => {
  if (typeof window === 'undefined') return
  if (active) window.addEventListener('keydown', onKeydown)
  else window.removeEventListener('keydown', onKeydown)
}, { immediate: true })

// [ui-p2c-render-probe-v1] mount/update 各打一次；判据①用 update delta 算单事件重渲染卡数
onMounted(() => probeRender(`rc:${props.card.key}`, 'mount'))
onUpdated(() => probeRender(`rc:${props.card.key}`, 'update'))
onBeforeUnmount(() => { if (typeof window !== 'undefined') window.removeEventListener('keydown', onKeydown) })

/**
 * [ask-hotkey-v1] 数字键 1–9 快速选择：主流智能体（Cursor / Claude Code）的通用交互。
 * [CONSTRAINT] 只在 isAskActive 且目标不在输入框内时响应；卸载时移除监听。
 */
function onKeydown(e: KeyboardEvent): void {
  if (!isAskActive.value) return
  if (!qCard.value.options.length) return
  // [ask-hotkey-v2] 排除所有可编辑区域：input / textarea / contenteditable。
  //   [WHY] 原实现只排除 input/textarea，导致 contenteditable 编辑器（CodeMirror 等）
  //   里打字时数字键被全局监听吞掉（用户实测无法输入数字）。
  const el = e.target as HTMLElement | null
  const tag = el?.tagName?.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || el?.isContentEditable === true) return
  const n = Number(e.key)
  if (!Number.isInteger(n) || n < 1 || n > qCard.value.options.length) return
  e.preventDefault()
  submitAnswer(qCard.value.options[n - 1].label)
}
function onImeStart(): void { _imeComposing.value = true }
function onImeEnd(e: CompositionEvent): void {
  _imeComposing.value = false
  askDraft.value = (e.target as HTMLInputElement).value
}
function onAskInput(e: Event): void {
  if (_imeComposing.value) return
  askDraft.value = (e.target as HTMLInputElement).value
}
// [ask-ime-v3] 兜底复位：输入法在某些浏览器/焦点切换下不触发 compositionend，
//   导致 _imeComposing 永久为 true ⇒ askDraft 再不更新 ⇒ 发送按钮永久禁用（用户实测点不动）。
function onAskBlur(e: FocusEvent): void {
  _imeComposing.value = false
  askDraft.value = (e.target as HTMLInputElement).value
}
/** 发送入口：强制复位 IME 标志并从 DOM 取当前值，避免任何组字状态卡死发送 */
function submitDraftFromInput(e: Event): void {
  _imeComposing.value = false
  const el = (e.target as HTMLFormElement).querySelector('input') as HTMLInputElement | null
  if (el) askDraft.value = el.value
  submitAnswer(askDraft.value)
}
function submitAnswer(text: string): void {
  const t = String(text || '').trim()
  if (!t) return
  // [ask-submit-guaranteed-v1] 不再因 isAskActive=false 静默丢弃：
  //   历史卡片（刷新后 / 被新提问取代过）仍应可点击回答——否则表现为「点了没反应」（用户实测）。
  //   只需 askId 存在即可尝试重建活跃提问。
  if (!qCard.value.askId) return
  // [ask-answer-key-v2] 回答事件的 updateKey 必须用**卡片的 askId**（= turn 块 id）：
  //   askUser 旧路径的 id 是 a1/a2 自增序号，与卡片 updateKey（askq-<blockId>）不同 ⇒
  //   resolveAsk 发出的更新匹配不上卡片，卡片永远不转「已回答」（用户实测点了没反应）。
  if (!askState.value) restoreAsk(qCard.value.askId, qCard.value.text, qCard.value.options)
  askDraft.value = ''
  answerAsk(qCard.value.askId, t)
  // [ask-answer-send-v1] 回答发送由 answerAsk 无条件 resolve 活跃提问驱动：
  //   askUser 的 .then(answer => copyAndFill(...)) 在 answerAsk 里被兑现，
  //   本组件不再直接调 copyAndFill / emit，保持纯 UI（happy-dom 可测）。
}
</script>

<template>
  <!-- done：任务完成 · 总结 -->
  <section v-if="card.type === 'done' && (card.text || card.preview).trim()" class="done-summary">
    <div class="done-summary-head">
      任务完成 · 总结
    </div>

    <div class="done-summary-body" v-html="html" />
  </section>

  <!-- text：AI 普通文本卡 -->
  <section v-else-if="card.type === 'text' && (card.text || card.preview).trim() !== 'json复制下载'" class="text-card">
    <div class="done-summary-body" v-html="html" />
  </section>

  <!-- ask：用户提问 / 回答卡 -->
  <section
    v-else-if="card.type === 'ask'"
    class="text-card is-bubble"
  >
    <!-- <header class="text-card-head">
      <span class="text-card-badge" :class="card.role === 'user-answer' ? 'answer-badge' : 'ask-badge'">你</span>
      <span class="script-card-time">{{ card.timeLabel }}</span>
    </header> -->
    <div class="done-summary-body" v-html="html" />
  </section>

  <!-- question：AI 提问卡（可点选 / 可打字） -->
  <section
    v-else-if="card.type === 'question'"
    class="question-card"
    :class="{ 'is-answered': qCard.answered, 'is-stale': !qCard.answered && !isAskActive }"
  >
    <header class="text-card-head">
      <span class="text-card-badge question-badge">ASK</span>
      <span class="script-card-time">{{ card.timeLabel }}</span>
      <span v-if="qCard.answered" class="question-state">已回答</span>
      <span v-else-if="!isAskActive" class="question-state is-stale">已失效</span>
    </header>
    <div v-if="card.text" class="done-summary-body" v-html="html" />
    <div v-if="qCard.options.length" class="question-options">
      <button
        v-for="(o, idx) in qCard.options" :key="o.id"
        class="question-opt" type="button"
        :disabled="qCard.answered || !qCard.askId"
        @click="submitAnswer(o.label)"
      >
        <span class="question-opt-num" aria-hidden="true">{{ idx + 1 }}</span>
        <span class="question-opt-label">{{ o.label }}</span>
      </button>
      <!-- [ask-hotkey-v1] 数字键快捷选择提示：仅在可交互时显示 -->
      <div v-if="isAskActive" class="question-hotkey-hint">
        按 1–{{ qCard.options.length }} 快速选择
      </div>
    </div>
    <div v-if="qCard.answered" class="question-answer">
      你的回答：{{ qCard.answer || '（已取消）' }}
    </div>
    <form
      v-else-if="isAskActive"
      class="question-input-row"
      @submit.prevent="submitDraftFromInput"
    >
      <input
        class="question-input"
        :value="askDraft"
        :placeholder="qCard.options.length ? '或输入自定义回答…' : '输入你的回答…'"
        @compositionstart="onImeStart"
        @compositionend="onImeEnd"
        @input="onAskInput"
        @blur="onAskBlur"
      >
      <button class="question-send" type="submit">
        发送
      </button>
    </form>
    <div v-else class="question-stale">
      此提问已失效（已被新的提问取代，或页面已刷新）
    </div>
  </section>
</template>

<style scoped lang="scss" src="./terminal-pane.scss"></style>
