<script setup lang="ts">
// [ui-p2c-render-probe-v1] V9 验收①：dev-only 渲染打点（生产 enabled() 早退）
import { onMounted, onUpdated } from 'vue'
import { probeRender } from '../../composables/ui/render-probe'
// [round-card-v1] 从 TerminalPane 抽出：done / text / ask / question 四类非脚本卡片
// [WHY] TerminalPane 超 HCLC 500 红线；四类卡片共用 text-card 布局
// [CHANGE-IMPACT] expanded 态下沉到卡片内（不再用父级 expandedCards 集合）

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

const expanded = ref(false)
const askDraft = ref('')

const { askState, resolveAsk } = useAsk()

const collapsed = computed(() => props.card.truncated && !expanded.value)
const html = computed(() => renderMarkdown(collapsed.value ? props.card.preview : props.card.text))
const qCard = computed(() => props.card as QuestionCard)
const isQuestion = computed(() => props.card.type === 'question')
const isAskActive = computed(() => {
  if (!isQuestion.value) return false
  const c = qCard.value
  return !c.answered && Boolean(c.askId) && askState.value?.id === c.askId
})

// [ui-p2c-render-probe-v1] mount/update 各打一次；判据①用 update delta 算单事件重渲染卡数
onMounted(() => probeRender(`rc:${props.card.key}`, 'mount'))
onUpdated(() => probeRender(`rc:${props.card.key}`, 'update'))

function toggle(): void { expanded.value = !expanded.value }
function submitAnswer(text: string): void {
  const t = String(text || '').trim()
  if (!t || !isAskActive.value) return
  askDraft.value = ''
  resolveAsk(t)
}
</script>

<template>
  <!-- done：任务完成 · 总结 -->
  <section v-if="card.type === 'done'" class="done-summary">
    <div class="done-summary-head">
      任务完成 · 总结
    </div>
    <div class="done-summary-body" v-html="html" />
    <FoldToggle
      v-if="card.truncated"
      :expanded="expanded"
      :hidden-lines="card.hiddenLines"
      @toggle="toggle"
    />
  </section>

  <!-- text：AI 普通文本卡 -->
  <section v-else-if="card.type === 'text'" class="text-card">
    <header class="text-card-head">
      <span class="text-card-badge">AI</span>
      <span class="script-card-time">{{ card.timeLabel }}</span>
    </header>
    <div class="done-summary-body" v-html="html" />
    <FoldToggle
      v-if="card.truncated"
      :expanded="expanded"
      :hidden-lines="card.hiddenLines"
      @toggle="toggle"
    />
  </section>

  <!-- ask：用户提问 / 回答卡 -->
  <section
    v-else-if="card.type === 'ask'"
    class="text-card"
    :class="card.role === 'user-answer' ? 'answer-card' : 'ask-card'"
  >
    <header class="text-card-head">
      <span class="text-card-badge" :class="card.role === 'user-answer' ? 'answer-badge' : 'ask-badge'">你</span>
      <span class="script-card-time">{{ card.timeLabel }}</span>
    </header>
    <div class="done-summary-body" v-html="html" />
    <FoldToggle
      v-if="card.truncated"
      :expanded="expanded"
      :hidden-lines="card.hiddenLines"
      @toggle="toggle"
    />
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
    <FoldToggle
      v-if="card.truncated"
      :expanded="expanded"
      :hidden-lines="card.hiddenLines"
      @toggle="toggle"
    />
    <div v-if="qCard.options.length" class="question-options">
      <button
        v-for="o in qCard.options" :key="o.id"
        class="question-opt" type="button"
        :disabled="!isAskActive"
        @click="submitAnswer(o.label)"
      >
        {{ o.label }}
      </button>
    </div>
    <div v-if="qCard.answered" class="question-answer">
      你的回答：{{ qCard.answer || '（已取消）' }}
    </div>
    <form
      v-else-if="isAskActive"
      class="question-input-row"
      @submit.prevent="submitAnswer(askDraft)"
    >
      <input
        class="question-input"
        :value="askDraft"
        :placeholder="qCard.options.length ? '或输入自定义回答…' : '输入你的回答…'"
        @input="askDraft = ($event.target as HTMLInputElement).value"
      >
      <button class="question-send" type="submit" :disabled="!askDraft.trim()">
        发送
      </button>
    </form>
    <div v-else class="question-stale">
      此提问已失效（已被新的提问取代，或页面已刷新）
    </div>
  </section>
</template>

<style scoped lang="scss" src="./terminal-pane.scss"></style>
