<script setup lang="ts">
// [tier1c-5] trust visualization: overall + gauge + calibration
import { computed } from 'vue'

interface Calib { tier: string, n: number, expected: number, actual: number, gap: number, verdict: string }
interface Drift { totalRounds: number, driftRounds: number, driftRate: number, verdict: string }
interface Trust { overall: number, calibration: Calib[], drift: Drift, updatedAt: string }

interface Props { trust?: Trust }

/** 组件接收的 props 定义 */
const props = withDefaults(defineProps<Props>(), { trust: undefined })

/** 等级 */
const level = computed(() => {
  const t = props.trust
  if (!t) return 'unknown'
  if (t.overall >= 80) return 'good'
  if (t.overall >= 60) return 'warn'
  return 'bad'
})

/** 等级文本 */
const levelText = computed(() => {
  const l = level.value
  if (l === 'good') return 'high'
  if (l === 'warn') return 'medium'
  if (l === 'bad') return 'low'
  return 'unknown'
})

/** 百分比（0-100） */
const pct = computed(() => {
  const t = props.trust
  if (!t) return 0
  return Math.max(0, Math.min(100, Math.round(t.overall)))
})

/** 校准数据 */
const calib = computed(() => (props.trust && Array.isArray(props.trust.calibration)) ? props.trust.calibration : [])

/**
 * 执行 gap Class
 * @param g - g
 */
function gapClass(g: number): string {
  const a = Math.abs(g)
  if (a < 10) return 'ok'
  return g < 0 ? 'overconfident' : 'overconservative'
}

/**
 * 执行 gap Label
 * @param g - g
 */
function gapLabel(g: number): string {
  const a = Math.abs(g)
  if (a < 10) return 'ok'
  return g < 0 ? 'over' : 'under'
}

/**
 * 执行 fmt Updated
 * @param iso - iso
 */
function fmtUpdated(iso?: string): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    return `${hh}:${mm}`
  } catch { return '' }
}
</script>

<template>
  <div v-if="trust" class="tg" :class="`is-${level}`">
    <div class="tg-head">
      <span class="tg-title">Trust</span>
      <span class="tg-score">{{ pct }}</span>
      <span class="tg-level">{{ levelText }}</span>
      <span class="tg-updated">{{ fmtUpdated(trust.updatedAt) }}</span>
    </div>
    <div class="tg-gauge">
      <div class="tg-gauge-fill" :style="{ width: `${pct}%` }" />
      <div class="tg-gauge-marks">
        <span class="tg-mark tg-mark-60" />
        <span class="tg-mark tg-mark-80" />
      </div>
    </div>
    <div class="tg-drift">
      <span class="tg-drift-label">Drift</span>
      <span class="tg-drift-value">{{ trust.drift.driftRounds }}/{{ trust.drift.totalRounds }} ({{ trust.drift.driftRate }}%)</span>
    </div>
    <div v-if="calib.length" class="tg-calib">
      <div v-for="c in calib" :key="c.tier" class="tg-calib-row">
        <span class="tg-calib-tier">{{ c.tier }}</span>
        <span class="tg-calib-n">n={{ c.n }}</span>
        <span class="tg-calib-expected">exp {{ c.expected }}%</span>
        <span class="tg-calib-actual">act {{ c.actual }}%</span>
        <span class="tg-calib-gap" :class="`is-${gapClass(c.gap)}`">{{ gapLabel(c.gap) }} {{ c.gap > 0 ? "+" : "" }}{{ c.gap }}</span>
      </div>
    </div>
    <div v-else class="tg-empty">
      no calibration
    </div>
  </div>
</template>

<style scoped>
.tg {
  padding: 8px 12px;
  font-size: 11px;
  font-family: var(--mono, monospace);
  border-top: 1px solid var(--border, #334155);
}
.tg-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 6px;
}
.tg-title {
  color: var(--text-3, #94a3b8);
  font-weight: 600;
}
.tg-score {
  font-size: 16px;
  font-weight: 700;
}
.tg.is-good .tg-score {
  color: #22c55e;
}
.tg.is-warn .tg-score {
  color: #eab308;
}
.tg.is-bad .tg-score {
  color: #ef4444;
}
.tg-level {
  color: var(--text-2, #cbd5e1);
  font-size: 10px;
}
.tg-updated {
  margin-left: auto;
  color: var(--text-3, #94a3b8);
  font-size: 10px;
}
.tg-gauge {
  position: relative;
  height: 8px;
  background: var(--surface-3, #2f2f2f);
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 6px;
}
.tg-gauge-fill {
  height: 100%;
  transition: width 0.3s ease;
}
.tg.is-good .tg-gauge-fill {
  background: linear-gradient(90deg, #16a34a, #22c55e);
}
.tg.is-warn .tg-gauge-fill {
  background: linear-gradient(90deg, #ca8a04, #eab308);
}
.tg.is-bad .tg-gauge-fill {
  background: linear-gradient(90deg, #b91c1c, #ef4444);
}
.tg-gauge-marks {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.tg-mark {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: rgba(255, 255, 255, 0.3);
}
.tg-mark-60 {
  left: 60%;
}
.tg-mark-80 {
  left: 80%;
}
.tg-drift {
  display: flex;
  gap: 8px;
  margin-bottom: 6px;
}
.tg-drift-label {
  color: var(--text-3, #94a3b8);
}
.tg-drift-value {
  color: var(--text-2, #cbd5e1);
}
.tg-calib {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tg-calib-row {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 10px;
}
.tg-calib-tier {
  width: 50px;
  color: var(--text-2, #cbd5e1);
}
.tg-calib-n {
  width: 42px;
  color: var(--text-3, #94a3b8);
}
.tg-calib-expected {
  width: 64px;
  color: var(--text-3, #94a3b8);
}
.tg-calib-actual {
  flex: 1;
  color: var(--text-2, #cbd5e1);
}
.tg-calib-gap.is-ok {
  color: #22c55e;
}
.tg-calib-gap.is-overconfident {
  color: #ef4444;
}
.tg-calib-gap.is-overconservative {
  color: #eab308;
}
.tg-empty {
  color: var(--text-3, #94a3b8);
  font-size: 10px;
}
</style>
