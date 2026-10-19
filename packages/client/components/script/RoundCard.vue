<script setup lang="ts">
// [ui-p2c-render-probe-v1] V9 验收①：dev-only 渲染打点（生产 enabled() 早退）
import { onMounted, onUpdated } from 'vue'
import { probeRender } from '../../composables/ui/render-probe'
// [fold-toggle-import-v1] 折叠入口必须显式 import。
// [WHY] 本项目**没有** unplugin-vue-components（vite.config.ts 只装 unplugin-auto-import，
//   且 auto-import 的 dirs 是 composables/utils、不含 components），main.ts 也无 app.component() 全局注册
//   ⇒ 模板里的 PascalCase 组件只有显式 import 才解析得到。缺失时 Vue 把它当未知元素：不报错、不渲染，
//   而 text/done/ask/question 四类卡片的「展开全部 · 还有 N 行」入口**静默消失** ——
//   超阈值内容只剩 12 行预览（TEXT_PREVIEW）且无法展开（2026-10-09 用户截图「回答被截断」根因）。
// [CONSTRAINT] 由 tests/component-binding-guard.node-test.ts 守卫：删掉本行即变红。
import FoldToggle from './FoldToggle.vue'
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

// [ask-full-v1] 提问类卡片（AI 的 ASK 卡 / 用户提问卡）默认展开全文，对标宿主智能体的提问呈现：
//   提问与上下文必须完整可读才能回答/决策；原 [timeline-denoise-v1] 的预览+折叠保留为
//   手动「收起」（文字墙风险交还给用户自控），阈值计算不动（truncated/hiddenLines 仍驱动 toggle）。
// [CONSTRAINT] 仅改默认值：truncated=false 时 toggle 不渲染，expanded 取值无副作用；
//   卡片 key 含事件 id ⇒ 同一实例的 card.type 不会变化，setup 期读一次安全。
const expanded = ref(
  (props.card.type === 'question' || props.card.type === 'ask') && props.card.truncated,
)
const askDraft = ref('')

const { askState, resolveAsk, restoreAsk } = useAsk()

const collapsed = computed(() => props.card.truncated && !expanded.value)
const html = computed(() => renderMarkdown(collapsed.value ? props.card.preview : props.card.text))
const qCard = computed(() => props.card as QuestionCard)
const isQuestion = computed(() => props.card.type === 'question')
const isAskActive = computed(() => {
  if (!isQuestion.value) return false
  const c = qCard.value
  // [ask-restore-v1] 刷新后 askState 为空但卡片未回答 ⇒ 仍可交互（点击时用 restoreAsk 重建）
  if (c.answered) return false
  if (!c.askId) return false
  if (!askState.value) return true
  return askState.value.id === c.askId
})

// [ui-p2c-render-probe-v1] mount/update 各打一次；判据①用 update delta 算单事件重渲染卡数
onMounted(() => probeRender(`rc:${props.card.key}`, 'mount'))
onUpdated(() => probeRender(`rc:${props.card.key}`, 'update'))

function toggle(): void { expanded.value = !expanded.value }
function submitAnswer(text: string): void {
  const t = String(text || '').trim()
  if (!t || !isAskActive.value) return
  // [ask-restore-v1] 刷新后无活跃提问：先重建，否则 resolveAsk 会静默返回
  if (!askState.value && qCard.value.askId) restoreAsk(qCard.value.askId, qCard.value.text, qCard.value.options)
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
    <FoldToggle
      v-if="card.truncated"
      :expanded="expanded"
      :hidden-lines="card.hiddenLines"
      @toggle="toggle"
    />
    <div class="done-summary-body" v-html="html" />
    <FoldToggle
      v-if="card.truncated && expanded"
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
    <FoldToggle
      v-if="card.truncated"
      :expanded="expanded"
      :hidden-lines="card.hiddenLines"
      @toggle="toggle"
    />
    <div class="done-summary-body" v-html="html" />
    <FoldToggle
      v-if="card.truncated && expanded"
      :expanded="expanded"
      :hidden-lines="card.hiddenLines"
      @toggle="toggle"
    />
  </section>

  <!-- ask：用户提问 / 回答卡 -->
  <section
    v-else-if="card.type === 'ask'"
    class="text-card"
  >
    <header class="text-card-head">
      <span class="text-card-badge" :class="card.role === 'user-answer' ? 'answer-badge' : 'ask-badge'">你</span>
      <span class="script-card-time">{{ card.timeLabel }}</span>
    </header>
    <FoldToggle
      v-if="card.truncated"
      :expanded="expanded"
      :hidden-lines="card.hiddenLines"
      @toggle="toggle"
    />
    <div class="done-summary-body" v-html="html" />
    <FoldToggle
      v-if="card.truncated && expanded"
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
    <FoldToggle
      v-if="card.truncated"
      :expanded="expanded"
      :hidden-lines="card.hiddenLines"
      @toggle="toggle"
    />
    <div v-if="card.text" class="done-summary-body" v-html="html" />
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
    <FoldToggle
      v-if="card.truncated && expanded"
      :expanded="expanded"
      :hidden-lines="card.hiddenLines"
      @toggle="toggle"
    />
  </section>
</template>

<style scoped lang="scss" src="./terminal-pane.scss"></style>
