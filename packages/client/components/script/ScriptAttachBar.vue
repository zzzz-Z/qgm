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

defineProps<{ files: AttachedFile[] }>()

/** 派发 */
const emit = defineEmits<{ remove: [id: string] }>()

interface AttachedFile {
  id: string
  name: string
  size: number
  kind: 'image' | 'text' | 'folder'
  content: string
}
</script>

<style scoped lang="scss">
// 附件条与输入框卡片同体：透明背景 + 无底部分界线
.attach-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 4px 16px 0;
  background: transparent;
  max-height: 120px;
  overflow-y: auto;
}

// 附件标签圆角 10px 与卡片同族；半透明底更融入输入框
.attach-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 10px;
  background: rgba(127, 127, 127, 0.08);
  border: 1px solid transparent;
  font-size: 11.5px;
  color: var(--text, inherit);
  max-width: 260px;
  justify-content: center;
  transition:
    background 0.15s ease,
    border-color 0.15s ease;
}

.attach-tag:hover {
  background: rgba(127, 127, 127, 0.14);
  border-color: rgba(127, 127, 127, 0.2);
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
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--text-3, rgba(127, 127, 127, 0.7));
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}

.attach-del:hover {
  color: var(--danger, #f85149);
  background: rgba(248, 81, 73, 0.14);
}

.attach-tag .attach-ico,
.attach-tag .attach-name,
.attach-tag .attach-size {
  padding: 2px 8px;
  font-size: 11px;
}
</style>
