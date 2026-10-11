// [trae-shell-v1] 折叠态提为模块级单例：header（App.vue）与左栏（AiWindowList.vue）
//   分属两组件，须共享同一份 ref；否则 header 按钮改状态、左栏 class 不动。
import type { WritableComputedRef } from 'vue'
import { computed } from 'vue'
import { useFoldState } from './useFoldState'

/** 与 AiWindowList 折叠持久化共用同一 key（airunner:fold:default:ai-window-list） */
const fold = useFoldState('default', 'ai-window-list')

/** 左栏折叠态：true = 收成图标条；语义与 useFoldState 一致（expanded 反向） */
export const aiWindowListCollapsed: WritableComputedRef<boolean> = computed({
  get: () => !fold.isOpen('expanded', false),
  set: (v: boolean) => fold.setOpen('expanded', !v),
})
