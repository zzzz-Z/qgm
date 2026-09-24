<script setup lang="ts">
// [decision-switch-v2] 决策三档预设按钮；高级模式（七类精细配置）已下线
import type { Preset } from '../../composables/ui/useDecisionPolicy'
import { PRESET_LABELS, useDecisionPolicy } from '../../composables/ui/useDecisionPolicy'

defineOptions({ name: 'DecisionPolicySwitch' })

const { preset, setPreset } = useDecisionPolicy()
/** 决策策略预设列表 */
const PRESETS: Preset[] = ['trust', 'collaborative', 'supervisor']

/**
 * 执行 preset Tip
 * @param p - p
 */
function presetTip(p: Preset): string {
  if (p === 'trust') return '信任：全部决策全自动执行，AI 自主推进'
  if (p === 'collaborative') return '协作：脚本生成与熔断判定需你确认，其余全自动'
  return '监工：默认人工确认，仅格式化操作全自动'
}
</script>

<template>
  <div class="dps">
    <button
      v-for="p in PRESETS"
      :key="p"
      v-tooltip="presetTip(p)"
      class="dps-preset"
      :class="{ active: preset === p }"
      type="button"
      @click="setPreset(p)"
    >
      {{ PRESET_LABELS[p] }}
    </button>
  </div>
</template>

<style scoped>
.dps {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.dps-preset {
  padding: 4px 10px;
  border: 1px solid var(--border, #334155);
  background: var(--surface-2, #252525);
  color: var(--text-2, #cbd5e1);
  font-size: 11px;
  border-radius: 4px;
  cursor: pointer;
  transition:
    border-color 0.15s,
    background 0.15s;
}
.dps-preset:hover {
  border-color: var(--primary, #3b82f6);
}
.dps-preset.active {
  background: var(--primary, #3b82f6);
  color: #fff;
  border-color: var(--primary, #3b82f6);
}
</style>
