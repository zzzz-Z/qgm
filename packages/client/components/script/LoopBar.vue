<script setup lang="ts">
import { useAutoLoop } from '../../composables/ai/useAutoLoop'
import { formatCost } from '../../utils/pricing'
import { useInterruptPolicy } from '../../composables/ui/useInterruptPolicy'
import { computed, ref } from 'vue'

defineOptions({ name: 'LoopBar' })

/** v-model 绑定的双向值 */
const model = defineModel<boolean>({ required: true })

// [loopbar-copy-v2] 状态文案映射 + 轮次归一化（无上限时不显示 Infinity）
/** 状态标签 */
const STATE_LABEL: Record<string, string> = {
  'running': '运行中',
  'waiting': '等待 AI 回复',
  'parsing': '解析回复中',
  'executing': '执行脚本中',
  'feedback': '回填结果中',
  'budget-limited': '预算用尽',
  'waiting-input': '等待决策',
  'interrupted': '已中断',
  'stopped': '已停止',
}

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
  resumeFromPause,
  loopPaused,
  requestPause,
} = useAutoLoop()

/** 决策打开 */
const decisionCustomOpen = ref(false)
/** 决策文本 */
const decisionCustomText = ref('')
// [tier1c-2] 打断礼仪：预算 + 静音时段
const { remaining, maxPerWindow, quietNow, reasonText } = (() => {
  const p = useInterruptPolicy()
  return {
    remaining: p.remaining,
    maxPerWindow: computed(() => p.policy.value.maxPerWindow),
    quietNow: p.quietNow,
    reasonText: p.reasonText,
  }
})()

/** 等待 */
const waitingPct = computed(() => {
  if (loopState.value !== 'waiting' || !roundTimeoutMs.value) return 0
  return Math.min(100, Math.round((waitingElapsed.value * 1000 / roundTimeoutMs.value) * 100))
})
/** 标签 */
const stageLabel = computed(() => {
  const s = stage.value
  if (s === 'plan') return '规划'
  if (s === 'verify') return '验证'
  return '实现'
})
/** 阶段样式类名 */
const stageClass = computed(() => `stage-${stage.value || 'plan'}`)
/** 状态标签 */
const stateLabel = computed(() => STATE_LABEL[loopState.value] || loopState.value)
/** 轮次文本 */
const roundText = computed(() => {
  const m = Number(maxRounds)
  return Number.isFinite(m) && m > 0 ? (`第 ${loopRound.value}/${m} 轮`) : (`第 ${loopRound.value} 轮`)
})
/** 状态 */
const stateIcon = computed(() => {
  const s = loopState.value
  if (s === 'waiting') return '⏱'
  if (s === 'executing') return '⚙'
  if (s === 'feedback') return '🔙'
  if (s === 'parsing') return '🧩'
  if (s === 'handoff') return '🔄'
  if (s === 'budget-limited') return '💰'
  if (s === 'waiting-input') return '⏸'
  return '⟳'
})
/** 轮次 */
const roundPct = computed(() => {
  const max = maxRounds || 8
  return Math.min(100, Math.round((loopRound.value / max) * 100))
})
// [tier1c-1a] 卡住检测：waiting 时按 elapsed/timeout 分三档
//   ok    < 60%    正常
//   warn  60%~90%  留意（回复慢）
//   stuck > 90%    疑似卡住（即将熔断）
/** 卡住检测等级：ok / warn / stuck */
const stuckLevel = computed(() => {
  if (loopState.value !== 'waiting') return 'ok'
  const total = roundTimeoutMs.value || 0
  if (!total) return 'ok'
  const ratio = (waitingElapsed.value * 1000) / total
  if (ratio >= 0.9) return 'stuck'
  if (ratio >= 0.6) return 'warn'
  return 'ok'
})
/** 卡住提示文本 */
const stuckTip = computed(() => {
  const total = Math.round((roundTimeoutMs.value || 0) / 1000)
  const el = waitingElapsed.value
  if (stuckLevel.value === 'stuck') return `疑似卡住：已等 ${el}s / ${total}s，超时即熔断；可「停当前」终止`
  if (stuckLevel.value === 'warn') return `回复偏慢：已等 ${el}s / ${total}s`
  return `等待 AI 回复（已等 ${el}s / 总 ${total}s，超时即熔断）`
})

// [loopbar-exit-v1] [loopbar-exit-fix1] 归档小结：写一条 loop 类型 trace
/**
 * 执行 archive Summary
 */
function archiveSummary() {
  const parts = []
  parts.push(`循环结束：${stateLabel.value}`)
  if (loopRound.value > 0) parts.push(`共 ${loopRound.value} 轮`)
  if (tokenDelta.value > 0) parts.push(`tok ${(tokenDelta.value / 1000).toFixed(1)}k`)
  if (loopCost.value !== null) parts.push(formatCost(loopCost.value))
  // 保留 loopUsage 引用（供未来细分花费）
  if (loopUsage.value && loopUsage.value.prompt_tokens) parts.push(`prompt ${(loopUsage.value.prompt_tokens / 1000).toFixed(1)}k`) // [loopbar-exit-fix2]
  if (stopReason.value) parts.push(stopReason.value)
  const summary = parts.join(' · ')
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('ai-runner:trace', { detail: { kind: 'loop', summary } }))
    }
  } catch { /* ignore */ }
}
/**
 * 执行 submit Decision Custom
 */
function submitDecisionCustom() {
  const t = decisionCustomText.value.trim()
  if (!t) return
  void submitDecision('__custom__', t)
  decisionCustomOpen.value = false
  decisionCustomText.value = ''
}
</script>
<!-- [remove-confidence-v1] removed 2 blocks -->

<template>
  <section v-if="loopState !== 'idle'" class="loop-bar card" :class="`is-${loopState}`">
    <template v-if="loopState === 'budget-limited'">
      <span class="loop-status">
        <span>⏸</span>
        预算用尽 · {{ roundText }}
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
        等待决策 · {{ roundText }}
      </span>
      <!-- [tier1c-2] 打断礼仪：预算与静音提示 -->
      <span
        class="loop-interrupt-chip"
        :class="{ 'is-exhausted': remaining <= 0, 'is-quiet': quietNow }"
        :title="`${reasonText}（${remaining}/${maxPerWindow}）`"
      >
        <span class="loop-interrupt-icon">{{ quietNow ? '🔇' : '⚡' }}</span>
        <span class="loop-interrupt-text">{{ remaining }}/{{ maxPerWindow }}</span>
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
      <span class="loop-status" role="status" aria-live="polite" :aria-label="`当前状态：${stateLabel}${loopRound > 0 ? `，共 ${loopRound} 轮` : ''}`"> <!-- [loopbar-a11y-status-v1] -->
        <span class="loop-spin">{{ stateIcon }}</span>
        <span class="loop-stage-badge" :class="stageClass">{{ stageLabel }}</span>
        {{ roundText }} · {{ stateLabel }}
        <template v-if="tokenDelta > 0"> · {{ (tokenDelta / 1000).toFixed(1) }}k/{{ (tokenBudget / 1000) }}k tok</template>
        <template v-if="loopCost !== null"> · {{ formatCost(loopCost) }}</template>
        <template v-if="toleranceLeft < 3"> · 宽容余 {{ toleranceLeft }}</template>
      </span>
      <span
        v-if="loopState === 'waiting'" class="loop-waiting-progress" :class="`is-${stuckLevel}`"
        :title="stuckTip"
      >
        <span class="loop-waiting-text">⏱ {{ waitingElapsed }}s / {{ Math.round(roundTimeoutMs / 1000) }}s</span>
        <span class="loop-waiting-bar"><span
          class="loop-waiting-fill"
          :style="{ width: `${waitingPct}%` }"
        /></span>
      </span>
      <!-- [tier1c-1a] 卡住检测 chip：warn 起显现，stuck 强调 -->
      <span v-if="stuckLevel !== 'ok'" class="loop-stuck-chip" :class="`is-${stuckLevel}`" :title="stuckTip">
        <span class="loop-stuck-icon">{{ stuckLevel === 'stuck' ? '⚠' : '⏳' }}</span>
        <span class="loop-stuck-text">{{ stuckLevel === 'stuck' ? '疑似卡住' : '回复偏慢' }}</span>
      </span>
      <span class="loop-hard-chip" style="font-size:11px;font-family:monospace;color:var(--text-3);white-space:nowrap" title="循环硬上限：50 轮 / 30 分钟 / token 33k（牛马模式同样生效）">
        {{ loopRound }}/50轮 · ⛽ {{ (tokenDelta / 1000).toFixed(1) }}k/33k
      </span>
      <span class="loop-round-bar" :title="`轮次 ${loopRound}/${maxRounds}`">
        <span class="loop-round-fill" :style="{ width: `${roundPct}%` }" />
      </span>
      <span class="loop-goal-text" :title="loopGoal">{{ loopGoal.slice(0, 40) }}</span>
      <div class="loop-actions">
        <button v-tooltip="'立即终止当前执行（不等本轮完成）'" class="loop-btn kill" @click="killCurrent">
          ■ 停当前
        </button>
        <button v-tooltip="'Esc：当前轮跑完即停，不再发下一轮'" class="loop-btn" @click="requestPause">
          ⏸ 暂停
        </button>
        <!-- [pause-toggle-label-v1] LoopBar 独立「恢复」按钮已移除；恢复入口统一在 ScriptToolbar -->
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
      <!-- [loopbar-exit-v1] 退场体验：完成小结 + 归档 / 下一步 -->
      <span class="loop-end-status">
        {{ loopState === 'interrupted' ? '⏹' : '■' }} {{ stateLabel }}
        <template v-if="loopRound > 0"> · 共 {{ loopRound }} 轮</template>
        <em v-if="stopReason">· {{ stopReason }}</em>
      </span>
      <!-- 完成小结：轮次 / 累计 token / 累计花费（有值才展示） -->
      <span class="loop-end-summary" :title="`轮次 ${loopRound} · 累计 tok ${Math.round(tokenDelta / 1000)}k`">
        <span v-if="loopRound > 0" class="loop-end-chip">📊 {{ loopRound }} 轮</span>
        <span v-if="tokenDelta > 0" class="loop-end-chip">🔤 {{ (tokenDelta / 1000).toFixed(1) }}k tok</span>
        <span v-if="loopCost !== null" class="loop-end-chip">💰 {{ formatCost(loopCost) }}</span>
      </span>
      <button
        v-if="lastGoal" v-tooltip="`用相同目标重跑：${lastGoal.slice(0, 60)}`" class="loop-btn"
        @click="startLoop(lastGoal)"
      >
        🔄 再来一次
      </button>
      <!-- [loopbar-exit-v1] 归档入口：把本轮小结写进 trace 供后续复盘 -->
      <button
        v-tooltip="'把本轮小结写入会话记录，便于后续复盘'"
        class="loop-btn"
        data-mark="[loopbar-exit-archive-v1]"
        @click="archiveSummary"
      >
        📥 归档小结
      </button>
      <button class="loop-btn" @click="loopState = 'idle'">
        收起
      </button>
    </template>
  </section>
</template>

<style scoped lang="scss">
/* [loopbar-exit-v1] 收尾小结 chip 组 */
.loop-end-summary {
  display: inline-flex;
  gap: 6px;
  align-items: center;
}
.loop-end-chip {
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 11px;
  background: rgb(255 255 255 / 8%);
  color: rgb(220 226 236 / 92%);
}

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

/* [tier1c-1a] 卡住检测与等待形状分级 */
.loop-waiting-progress.is-warn .loop-waiting-fill {
  background: #e6a23c;
}
.loop-waiting-progress.is-stuck .loop-waiting-fill {
  background: var(--danger, #ef4444);
  animation: loop-waiting-pulse 1.1s ease-in-out infinite;
}
@keyframes loop-waiting-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}
.loop-stuck-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
  border: 1px solid transparent;
  white-space: nowrap;
}
.loop-stuck-chip.is-warn {
  color: #e6a23c;
  background: rgb(230 162 60 / 12%);
  border-color: rgb(230 162 60 / 40%);
}
.loop-stuck-chip.is-stuck {
  color: var(--danger, #ef4444);
  background: rgb(239 68 68 / 14%);
  border-color: rgb(239 68 68 / 55%);
  animation: loop-waiting-pulse 1.1s ease-in-out infinite;
}
.loop-stuck-icon {
  font-size: 12px;
  line-height: 1;
}

/* [tier1c-2] 打断礼仪预算 chip */
.loop-interrupt-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 7px;
  border-radius: 10px;
  font-size: 10px;
  font-family: var(--mono, monospace);
  color: var(--text-3, #94a3b8);
  background: rgb(148 163 184 / 10%);
  border: 1px solid rgb(148 163 184 / 30%);
}
.loop-interrupt-chip.is-quiet {
  color: #eab308;
  border-color: rgb(234 179 8 / 45%);
  background: rgb(234 179 8 / 12%);
}
.loop-interrupt-chip.is-exhausted {
  color: #ef4444;
  border-color: rgb(239 68 68 / 45%);
  background: rgb(239 68 68 / 12%);
}
.loop-interrupt-icon {
  font-size: 11px;
}
</style>
