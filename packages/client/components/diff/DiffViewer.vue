<script setup lang="ts">
// [git-diff-view-v1] 用 @git-diff-view/vue 替换手写 diff 渲染（自研 427 行 → 薄封装）。
// [WHY] 保留原 props 契约（before/after/fileName/changeType），调用方 FileContentOverlay
//   与 DiffOverlay 的 import 与用法零改动。
// [CONSTRAINT] 高亮、折叠、虚拟滚动、Split/Unified 切换交由库实现，不再维护自研版本。
import { computed } from 'vue'
import { DiffFile, DiffModeEnum, DiffView } from '@git-diff-view/vue'
import '@git-diff-view/vue/styles/diff-view.css'

const props = defineProps<{
  before: string
  after: string
  fileName: string
  changeType: 'added' | 'modified' | 'deleted'
  /** [diff-hunks-v1] 直接传入 git diff 文本片段（hunks 数组）；有值时优先于 before/after */
  hunks?: string[]
}>()

/** [git-diff-view-v1] 构造 DiffFile；hunks 优先，其次 before/after */
const diffFile = computed(() => {
  if (props.hunks && props.hunks.length) {
    const f = DiffFile.createInstance({ hunks: props.hunks })
    f.initTheme('dark')
    f.init()
    f.buildSplitDiffLines()
    return f
  }
  const before = props.changeType === 'added' ? '' : props.before
  const after = props.changeType === 'deleted' ? '' : props.after
  const f = DiffFile.createInstance({
    oldFile: { fileName: props.fileName, content: before },
    newFile: { fileName: props.fileName, content: after },
  })
  f.initTheme('dark')
  f.init()
  f.buildSplitDiffLines()
  return f
})
/** 变更统计：读库算好的行数，供 header 展示 */
const stats = computed(() => ({
  add: diffFile.value.additionLength ?? 0,
  del: diffFile.value.deletionLength ?? 0,
}))
</script>

<template>
  <div class="diff-viewer">
    <div class="diff-header">
      <span class="diff-filename">{{ fileName }}</span>
      <span class="diff-badge" :class="changeType">{{ changeType.toUpperCase() }}</span>
      <span class="diff-stats">
        <span v-if="stats.add" class="stat-add">+{{ stats.add }}</span>
        <span v-if="stats.del" class="stat-del">-{{ stats.del }}</span>
      </span>
    </div>
    <div class="diff-body">
      <DiffView
        :diff-file="diffFile"
        :diff-view-mode="DiffModeEnum.Split"
        diff-view-theme="dark"
        :diff-view-highlight="true"
        :diff-view-font-size="12"
      />
    </div>
  </div>
</template>

<style scoped>
.diff-viewer {
  border: 1px solid var(--border, #e5e7eb);
  border-radius: var(--radius, 8px);
  overflow: hidden;
  background: var(--surface);
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.diff-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px var(--diff-header-pr, 12px) 8px 12px;
  background: var(--surface-2, #f6f8fa);
  border-bottom: 1px solid var(--border, #e5e7eb);
  font-size: 13px;
  font-weight: 600;
}

.diff-filename {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--mono, monospace);
  font-size: 12px;
  font-weight: 500;
  color: var(--text, #1f2d3d);
}

.diff-badge {
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 4px;
  text-transform: uppercase;
}
.diff-badge.added {
  background: rgb(70 149 74 / 18%);
  color: #46954a;
}
.diff-badge.modified {
  background: rgb(220 160 40 / 18%);
  color: #dca028;
}
.diff-badge.deleted {
  background: rgb(229 83 75 / 18%);
  color: #e5534b;
}

.diff-stats {
  display: inline-flex;
  gap: 6px;
  font-family: var(--mono, monospace);
  font-size: 11px;
}
.stat-add {
  color: #46954a;
}
.stat-del {
  color: #e5534b;
}

.diff-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: var(--surface);
}

/* [git-diff-view-theme-v1] 库内部变量映射到项目深色主题 */
.diff-body :deep(.diff-view) {
  font-family: var(--mono, monospace);
  background: var(--surface) !important;
}
</style>
