<script setup lang="ts">
import { useAutoLoop } from '../../composables/ai/useAutoLoop'
import { formatCost } from '../../utils/pricing'
import { computed, ref } from 'vue'

defineOptions({ name: 'LoopBar' })

const model = defineModel<boolean>({ required: true })
const {
  loopState,
  loopRound,
  loopGoal,
  stopReason,
  toleranceLeft,
  stage,
  tokenDelta,
  maxRounds,
  tokenBudget,
  roundTimeoutMs,
  waitingElapsed,
  isLoopActive,
  loopUsage,
  loopCost,
  killCurrent,
  stopAndRollback,
  startHandoff,
  startLoop,
  lastGoal,
  pendingDecision,
  submitDecision,
  resumeLoop,
} = useAutoLoop()

const decisionCustomOpen = ref(false)
const decisionCustomText = ref('')

const waitingPct = computed(() => {
  if (loopState.value !== 'waiting' || !roundTimeoutMs.value) return 0
  return Math.min(100, Math.round((waitingElapsed.value * 1000 / roundTimeoutMs.value) * 100))
})

const stageLabel = computed(() => {
  const s = stage.value
  if (s === 'plan') return '规划'
  if (s === 'verify') return '验证'
  return '实现'
})

const stageClass = computed(() => `stage-${stage.value || 'plan'}`)

const stateIcon = computed(() => {
  const s = loopState.value
  if (s === 'waiting') return '⏱'
  if (s === 'executing') return '⚙'
  if (s === 'feedback') return '📤'
  if (s === 'parsing') return '🧩'
  if (s === 'handoff') return '🔄'
  if (s === 'budget-limited') return '💰'
  if (s === 'waiting-input') return '⏸'
  return '⟳'
})

const roundPct = computed(() => {
  const max = maxRounds || 8
  return Math.min(100, Math.round((loopRound.value / max) * 100))
})

function submitDecisionCustom() {
  const t = decisionCustomText.value.trim()
  if (!t) return
  void submitDecision('__custom__', t)
  decisionCustomOpen.value = false
  decisionCustomText.value = ''
}
</script>

<template>
  <section v-if="loopState !== 'idle'" class="loop-bar card" :class="`is-${loopState}`">
    <template v-if="loopState === 'budget-limited'">
      <span class="loop-status">
        <span>⏸</span>
        预算已用尽 · 第 {{ loopRound }}/{{ maxRounds }} 轮
      </span>
      <span class="loop-goal-text" :title="loopGoal">{{ loopGoal.slice(0, 40) }}</span>
      <div class="loop-actions">
        <button v-tooltip="'从当前轮次继续（token 基线重置）'" class="loop-btn" @click="resumeLoop">
          ▶ 继续
        </button>
        <button v-tooltip="'急停并 git reset 到循环起点'" class="loop-btn rollback" @click="stopAndRollback">
          ⏹
          停止并回滚
        </button>
      </div>

      <!-- skill menu 已移至编辑器工具栏内（details 原生） -->
    </template>
    <template v-else-if="loopState === 'waiting-input'">
      <span class="loop-status">
        <span>⏸</span>
        决策点 · 第 {{ loopRound }}/{{ maxRounds }} 轮
      </span>
      <span class="loop-goal-text" :title="pendingDecision?.question">{{ pendingDecision?.question || '（缺问题文本）'
      }}</span>
      <div class="loop-actions decision-actions">
        <button
          v-for="opt in (pendingDecision?.options || [])" :key="opt.id" v-tooltip="`选择「${opt.label}」并回填 AI`" :aria-label="`选择「${opt.label}」并回填 AI`"
          class="loop-btn decision-btn" @click="submitDecision(opt.id)"
        >
          {{ opt.label }}
        </button>
        <button v-tooltip="'取消决策点，结束循环'" class="loop-btn" @click="submitDecision('__cancel__')">
          <svg
            class="ico-svg"
            viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
            stroke-linejoin="round" aria-hidden="true"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg><span>取消</span>
        </button>
        <button v-tooltip="'输入自定义答案'" class="loop-btn" @click="decisionCustomOpen = !decisionCustomOpen">
          ✎
          自定义
        </button>
      </div>
      <div v-if="decisionCustomOpen" class="decision-custom">
        <input
          v-model="decisionCustomText" class="decision-input" placeholder="输入答案后回车发送"
          @keydown.enter.prevent="submitDecisionCustom"
        >
        <button
          class="loop-btn primary" :disabled="!decisionCustomText.trim()"
          @click="submitDecisionCustom"
        >
          发送
        </button>
      </div>
    </template>
    <template v-else-if="isLoopActive">
      <span class="loop-status">
        <span class="loop-spin">{{ stateIcon }}</span>
        <span class="loop-stage-badge" :class="stageClass">{{ stageLabel }}</span>
        第 {{ loopRound }}/{{ maxRounds }} 轮 · {{ loopState }}
        · tok {{ (tokenDelta / 1000).toFixed(1) }}k/{{ tokenBudget / 1000 }}k
        <template v-if="loopCost !== null"> · {{ formatCost(loopCost) }}（
          {{ (loopUsage.prompt_tokens / 1000).toFixed(1) }}k / {{ (loopUsage.completion_tokens / 1000).toFixed(1) }}k）
        </template>
        · 宽容 {{ toleranceLeft }}
      </span>
      <span
        v-if="loopState === 'waiting'" class="loop-waiting-progress"
        :title="`等待 AI 回复（已等 ${waitingElapsed}s / 总 ${Math.round(roundTimeoutMs / 1000)}s，超时即熔断）`"
      >
        <span class="loop-waiting-text">⏱ {{ waitingElapsed }}s / {{ Math.round(roundTimeoutMs / 1000) }}s</span>
        <span class="loop-waiting-bar"><span
          class="loop-waiting-fill"
          :style="{ width: `${waitingPct}%` }"
        /></span>
      </span>
      <span class="loop-round-bar" :title="`轮次 ${loopRound}/${maxRounds}`">
        <span class="loop-round-fill" :style="{ width: `${roundPct}%` }" />
      </span>
      <span class="loop-goal-text" :title="loopGoal">{{ loopGoal.slice(0, 40) }}</span>
      <div class="loop-actions">
        <button v-tooltip="'立即终止当前执行（不等本轮完成）'" class="loop-btn kill" @click="killCurrent">
          ■ 停当前
        </button>
        <button v-tooltip="'Esc：当前轮跑完即停，不再发下一轮'" class="loop-btn" disabled>
          ⏸ 暂停(Esc)
        </button>
        <button v-tooltip="'Ctrl+Esc：急停并 git reset 到循环起点'" class="loop-btn rollback" @click="stopAndRollback">
          ⏹
          停止并回滚
        </button>
        <button v-tooltip="'请求 AI 总结当前会话，切到新会话继续循环'" class="loop-btn" @click="startHandoff">
          🔄 轮转
        </button>
        <button v-tooltip="'给 AI 补充说明（下一轮反馈时带上）'" class="loop-btn" @click="model = !model">
          📝
          补充
        </button>
      </div>
    </template>
    <template v-else>
      <span class="loop-end-status">
        {{ loopState === 'interrupted' ? '⏹ 已中断' : '■ 已停止' }} · 第 {{ loopRound }}/{{ maxRounds }} 轮
        <em v-if="stopReason">（{{ stopReason }}）</em>
      </span>
      <button
        v-if="lastGoal" v-tooltip="`用相同目标重跑：${lastGoal.slice(0, 60)}`" class="loop-btn"
        @click="startLoop(lastGoal)"
      >
        🔄 再来一次
      </button>
      <button class="loop-btn" @click="loopState = 'idle'">
        收起
      </button>
    </template>
  </section>
</template>

<style scoped lang="scss">
.loop-bar {
  display: flex;
  flex-direction: row;

  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  flex: 0 0 auto;
  padding: 6px 12px;
  margin-bottom: 6px;
  min-height: 0;
  max-height: 88px;
  overflow: hidden;
  background: var(--surface);
  border: 1px solid var(--border);
  border-left-width: 4px;
  border-left-style: solid;
  border-left-color: var(--border-2);
  border-radius: var(--radius-8);
}

.loop-bar .loop-status {
  flex-shrink: 0;
  white-space: nowrap;
}

.loop-bar .loop-goal-text {
  flex: 1 1 auto;
  min-width: 0;
}

.loop-bar .loop-actions {
  flex-shrink: 0;
  margin-left: auto;
}

.loop-bar.is-running {
  border-left-color: #409eff;
}

.loop-bar.is-feedback {
  border-left-color: #e6a23c;
}

.loop-bar.is-interrupted {
  border-left-color: var(--danger);
}

.loop-bar.is-stopped {
  border-left-color: var(--text-3);
}

.loop-bar.is-budget-limited {
  border-left-color: #e6a23c;
}

.loop-status {
  font-size: var(--font-12);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.loop-goal-text {
  flex: 1 1 160px;
  font-size: var(--font-12);
  opacity: 0.7;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.loop-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.loop-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-height: 26px;
  padding: 0 12px;
  border: 1px solid rgb(255 255 255 / 8%);
  border-radius: var(--radius-6);
  background: transparent;
  color: var(--text-2);
  font: 500 12px/1 inherit;
  cursor: pointer;
  white-space: nowrap;
  box-shadow: none;
  transition:
    background 0.12s ease,
    color 0.12s ease,
    border-color 0.12s ease;
}

.loop-btn:active:not(:disabled) {
  transform: translateY(1px);
  box-shadow: none;
}

.loop-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  background: transparent;
  color: var(--text-3);
  box-shadow: none;
}

.loop-btn:hover:not(:disabled) {
  background: rgb(255 255 255 / 6%);
  color: var(--text);
  border-color: rgb(255 255 255 / 14%);
}

.loop-btn:focus-visible {
  outline: 0;
  box-shadow: 0 0 0 2px rgb(217 119 87 / 30%);
}

.loop-btn.primary {
  background: transparent;
  border-color: var(--primary);
  color: var(--primary);
  box-shadow: none;
}

.loop-btn.primary:hover:not(:disabled) {
  background: var(--primary-bg);
  border-color: var(--primary-hover);
  color: var(--primary-hover);
  box-shadow: none;
}

.loop-btn.rollback {
  background: transparent;
  border-color: rgb(224 108 117 / 55%);
  color: var(--danger);
  box-shadow: none;
}

.loop-btn.rollback:hover:not(:disabled) {
  background: rgb(224 108 117 / 14%);
  border-color: var(--danger);
  color: #fff;
  box-shadow: none;
}

.loop-btn .ico-svg {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  margin-right: 2px;
  display: inline-block;
  vertical-align: -1px;
}

.loop-btn svg {
  display: inline-block;
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  margin-right: 4px;
  vertical-align: -2px;
  visibility: visible;
  opacity: 1;
  fill: none;
  stroke: currentColor;
}
</style>
