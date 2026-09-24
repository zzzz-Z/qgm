// [decision-policy-v2] 决策三档预设（信任/协作/监工）；七类精细配置已下线
import { ref, watch } from 'vue'

/** 决策策略预设：标识 + 展示名 + 描述 */
export type Preset = 'trust' | 'collaborative' | 'supervisor'

/** 预设标识 → 展示名映射 */
export const PRESET_LABELS: Record<Preset, string> = {
  trust: '信任',
  collaborative: '协作',
  supervisor: '监工',
}

/** 存储键 */
const STORAGE_KEY = 'airunner:decision-policy'

/**
 * 加载 Preset
 */
function loadPreset(): Preset {
  try {
    if (typeof localStorage === 'undefined') return 'collaborative'
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return 'collaborative'
    const j = JSON.parse(raw)
    if (j === 'trust' || j === 'collaborative' || j === 'supervisor') return j
    if (j && typeof j === 'object') {
      const p = j.preset
      if (p === 'trust' || p === 'collaborative' || p === 'supervisor') return p
    }
    return 'collaborative'
  } catch { return 'collaborative' }
}

/**
 * 执行 save Preset
 * @param p - p
 */
function savePreset(p: Preset): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
  } catch { /* localStorage 满，忽略 */ }
}

/**
 * 组合式函数 Decision Policy
 */
export function useDecisionPolicy() {
  const preset = ref<Preset>(loadPreset())
  function setPreset(p: Preset): void { preset.value = p }
  watch(preset, (v) => { savePreset(v) })
  return { preset, setPreset }
}
