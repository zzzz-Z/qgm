<script setup lang="ts">
interface AttachedFile {
  id: string
  name: string
  size: number
  kind: 'image' | 'text' | 'folder'
  content: string
}

const props = defineProps<{ files: AttachedFile[] }>()
/** 派发 */
const emit = defineEmits<{ remove: [id: string] }>()

// [attachbar-rows-v1] 预生成行数据：tagTitle / fileBadge / fileToneStyle 每行仅算一次，
// 附件多时避免模板内重复调用（每次重渲染都执行）。
const rows = computed(() => props.files.map(f => ({
  id: f.id,
  // [attach-basename-v1] 芯片只展示文件名；全路径留在 title 悬停与发送逻辑里，
  //   前者信息不丢，后者按 name 全路径读文件（tree-attach 依赖）。
  name: f.name.split('/').pop() || f.name,
  kind: f.kind,
  content: f.content,
  title: tagTitle(f),
  badge: fileBadge(f.name),
  toneStyle: fileToneStyle(f.name),
})))

/** 悬停全文：Trae 风芯片不再内联展示体积，改挂到 title 上避免信息丢失 */
function tagTitle(f: AttachedFile): string {
  const size = f.kind === 'folder' ? `${f.size} 个文件` : fmtSize(f.size)
  return `${f.name} · ${size}`
}
</script>

<template>
  <div v-if="files.length" class="attach-bar">
    <div v-for="f in rows" :key="f.id" class="attach-tag" :class="`kind-${f.kind}`" :title="f.title">
      <img v-if="f.kind === 'image'" :src="f.content" :alt="f.name" class="attach-img">
      <span v-else-if="f.kind === 'folder'" class="attach-ico">📁</span>
      <span v-else class="attach-badge" :style="f.toneStyle">{{ f.badge }}</span>
      <span class="attach-name">{{ f.name }}</span>
      <button v-tooltip="'移除'" aria-label="移除" class="attach-del" @click="emit('remove', f.id)">
        ×
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
// 附件条与输入框卡片同体：透明背景 + 无底部分界线
.attach-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 16px 2px;
  background: transparent;
  max-height: 120px;
  overflow-y: auto;
}

// Trae 风芯片：类型角标 + 文件名，无 emoji、无体积、无重投影
.attach-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 7px;
  border-radius: 6px;
  background: rgb(127 127 127 / 8%);
  border: 1px solid rgb(127 127 127 / 16%);
  font-size: 11px;
  color: var(--text, inherit);
  max-width: 240px;
  transition:
    background 0.15s ease,
    border-color 0.15s ease;
}

.attach-tag:hover {
  background: rgb(127 127 127 / 14%);
  border-color: rgb(127 127 127 / 26%);
}

.attach-tag.kind-image {
  border-color: rgb(88 166 255 / 30%);
}

// 类型角标：等宽小字，承载 TS/VUE/MD 等短标签；配色由 fileToneStyle 按类型内联注入
.attach-badge {
  flex: 0 0 auto;
  padding: 0 3px;
  border-radius: 3px;
  font: 600 8.5px/1.5 var(--mono, monospace);
  letter-spacing: 0.3px;
}

.attach-img {
  width: 16px;
  height: 16px;
  object-fit: cover;
  border-radius: 3px;
  flex-shrink: 0;
  background: rgb(0 0 0 / 20%);
}

.attach-ico {
  font-size: 12px;
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

.attach-del {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--text-3, rgb(127 127 127 / 70%));
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}

.attach-del:hover {
  color: var(--danger, #f85149);
  background: rgb(248 81 73 / 14%);
}
</style>
