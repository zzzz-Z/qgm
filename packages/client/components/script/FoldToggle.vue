<script setup lang="ts">
// [timeline-denoise-v1] 长文本卡片的「展开全部 / 收起」入口
// [WHY] text / ask / done 三类卡片共用同一交互；抽组件避免三处重复的文案、aria 与样式，
//   也让 TerminalPane 保持在架构红线行数内（与 RoundDivider / ScriptCard 同一拆分理由）
// [CONSTRAINT] 只负责渲染与派发 toggle；展开态由父组件持有（按卡片 key 记录），
//   组件自身无状态 —— 卸载重建不会丢展开态
defineProps<{
  /** 当前是否已展开 */
  expanded: boolean
  /** 折叠掉的整行数，用于「还有 N 行」文案；展开态下不展示 */
  hiddenLines: number
}>()
const emit = defineEmits<{ toggle: [] }>()
</script>

<template>
  <button
    class="fold-toggle"
    type="button"
    :aria-expanded="expanded"
    @click="emit('toggle')"
  >
    <span class="fold-toggle-caret" :class="{ open: expanded }" aria-hidden="true">▸</span>
    <span>{{ expanded ? '收起' : `展开全部 · 还有 ${hiddenLines} 行` }}</span>
  </button>
</template>

<style scoped>
.fold-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 8px 0 0;
  padding: 3px 10px;
  border: 1px solid rgb(127 127 127 / 20%);
  border-radius: 999px;
  background: transparent;
  color: var(--text-3, #8b949e);
  font-size: 11.5px;
  line-height: 1.5;
  letter-spacing: 0.2px;
  cursor: pointer;
  transition:
    background-color 0.14s ease,
    color 0.14s ease,
    border-color 0.14s ease;
}
.fold-toggle:hover {
  background: rgb(127 127 127 / 8%);
  border-color: rgb(127 127 127 / 32%);
  color: var(--text-2, #c9d1d9);
}
.fold-toggle:focus-visible {
  outline: 2px solid var(--primary, #58a6ff);
  outline-offset: 2px;
}
.fold-toggle-caret {
  font-size: 9px;
  line-height: 1;
  transition: transform 0.15s ease;
}
.fold-toggle-caret.open {
  transform: rotate(90deg);
}
</style>
