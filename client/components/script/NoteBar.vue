<script setup lang="ts">
import { computed, ref } from 'vue'

defineOptions({ name: 'NoteBar' })

const emit = defineEmits<{ submit: [text: string], cancel: [] }>()
const draft = ref('')
const canSubmit = computed(() => draft.value.trim().length > 0)

function onSubmit() {
  if (!canSubmit.value) return
  emit('submit', draft.value.trim())
  draft.value = ''
}
function onCancel() {
  draft.value = ''
  emit('cancel')
}
</script>

<template>
  <section class="note-bar card">
    <textarea v-model="draft" class="note-input" rows="2" placeholder="给 AI 的补充说明（提交后下一轮反馈时带上，提交后清空）" />
    <div class="note-actions">
      <button class="loop-btn" @click="onCancel">
        <svg
          class="ico-svg"
          viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
          stroke-linejoin="round" aria-hidden="true"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg><span>取消</span>
      </button>
      <button class="loop-btn primary" :disabled="!canSubmit" @click="onSubmit">
        保存
      </button>
    </div>
  </section>
</template>

<style scoped lang="scss">
.note-bar {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px;
  margin-bottom: 6px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-8);
}

.note-input {
  width: 100%;
  min-height: 40px;
  padding: 6px 10px;
  font: 12px/1.5 var(--mono);
  color: var(--text);
  background: var(--surface-2);
  border: 1px solid var(--border-2);
  border-radius: var(--radius-6);
  outline: 0;
  resize: vertical;
}

.note-input:focus {
  border-color: var(--primary);
}

.note-actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
}
</style>
