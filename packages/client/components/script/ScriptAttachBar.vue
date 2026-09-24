<template>
  <div v-if="files.length" class="attach-bar">
    <div v-for="f in files" :key="f.id" class="attach-tag" :class="`kind-${f.kind}`">
      <img v-if="f.kind === 'image'" :src="f.content" :alt="f.name" class="attach-img">
      <span v-else-if="f.kind === 'folder'" class="attach-ico">📁</span>
      <span v-else class="attach-ico">📄</span>
      <span class="attach-name" :title="f.name">{{ f.name }}</span>
      <span class="attach-size">{{ f.kind === 'folder' ? `${f.size} 文件` : fmtSize(f.size) }}</span>
      <button v-tooltip="'移除'" aria-label="移除" class="attach-del" @click="emit('remove', f.id)">
        ×
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { fmtSize } from '../../utils/format'

interface AttachedFile {
  id: string
  name: string
  size: number
  kind: 'image' | 'text' | 'folder'
  content: string
}

defineProps<{ files: AttachedFile[] }>()

/** 派发 */
const emit = defineEmits<{ remove: [id: string] }>()
</script>

<style scoped lang="scss">
.attach-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border, var(--border));
  background: var(--surface-2, var(--surface-2));
  max-height: 120px;
  overflow-y: auto;
}

.attach-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: var(--radius-6);
  background: var(--surface, var(--surface));
  border: 1px solid var(--border, var(--border));
  font-size: 11.5px;
  color: var(--text, var(--text));
  max-width: 260px;
  justify-content: center;
}

.attach-tag.kind-image {
  border-color: rgb(88 166 255 / 30%);
}

.attach-img {
  width: 22px;
  height: 22px;
  object-fit: cover;
  border-radius: var(--radius-4);
  flex-shrink: 0;
  background: rgb(0 0 0 / 20%);
}

.attach-ico {
  font-size: 14px;
  line-height: 1;
}

.attach-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.attach-size {
  flex: 0 0 auto;
  color: var(--text-3, var(--text-3));
  font: 10px/1 var(--mono, monospace);
}

.attach-del {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: var(--radius-4);
  background: transparent;
  color: var(--text-3, var(--text-3));
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
}

.attach-del:hover {
  color: var(--danger);
  background: rgb(248 81 73 / 12%);
}

.attach-tag .attach-img {
  align-self: center;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.attach-tag .attach-del {
  align-self: center;
  line-height: 1.2;
}

.attach-tag .attach-ico,
.attach-tag .attach-name,
.attach-tag .attach-size {
  padding: 2px 8px !important;
  font-size: 11px !important;
}
</style>
