<script setup lang="ts">
// [abnormal-view-v1] PLAN 5.2 异常视图：本轮异常聚合 + 按严重度排序 + 默认隐藏
import { computed, ref, watch } from 'vue'

interface Props {
  result?: {
    ok?: boolean
    code?: number
    stderr?: string
    errorFiles?: string[]
    lint?: { ran?: boolean, ok?: boolean, stderr?: string, files?: number } | null
    test?: { ok?: boolean, stderr?: string, ran?: boolean } | null
    tsc?: { ok?: boolean, stdout?: string, stderr?: string, ran?: boolean } | null
  } | null
}

/** 组件接收的 props 定义 */
const props = withDefaults(defineProps<Props>(), { result: null })

type Severity = 'error' | 'warning' | 'info'

interface Item {
  severity: Severity
  source: string
  message: string
  files?: string[]
}

/** 严重程度 */
const severityOrder: Record<Severity, number> = { error: 0, warning: 1, info: 2 }

/**
 * 执行 first Lines
 * @param text - text
 * @param n - n
 */
function firstLines(text: string | undefined, n: number): string {
  if (!text) return ''
  const ls = text.split('\n').filter(Boolean)
  return ls.slice(0, n).join('\n')
}

/** 条目列表 */
const items = computed<Item[]>(() => {
  const out: Item[] = []
  const r = props.result
  if (!r) return out

  if (r.tsc && r.tsc.ran !== false && r.tsc.ok === false) {
    out.push({
      severity: 'error',
      source: 'tsc',
      message: firstLines(r.tsc.stdout || r.tsc.stderr, 5) || '类型检查失败',
    })
  }
  if (r.lint && r.lint.ran && r.lint.ok === false) {
    out.push({
      severity: 'error',
      source: 'eslint',
      message: firstLines(r.lint.stderr, 5) || 'lint 失败',
    })
  }
  if (r.test && r.test.ran !== false && r.test.ok === false) {
    out.push({
      severity: 'error',
      source: 'test',
      message: firstLines(r.test.stderr, 5) || '测试失败',
    })
  }
  if (r.code !== undefined && r.code !== null && r.code !== 0) {
    out.push({
      severity: r.code === 2 ? 'error' : 'warning',
      source: 'exit',
      message: `脚本退出码 ${r.code}`,
    })
  }
  if (Array.isArray(r.errorFiles) && r.errorFiles.length) {
    out.push({
      severity: 'warning',
      source: 'errorFiles',
      message: `${r.errorFiles.length} 个文件涉及错误`,
      files: r.errorFiles.slice(0, 20),
    })
  }
  return out.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])
})

/** 是否含错误 */
const hasError = computed(() => items.value.some(i => i.severity === 'error'))
/** 是否展开 */
const expanded = ref(false)

// 有 error 时自动展开
watch(items, (v) => { if (v.some(i => i.severity === 'error')) expanded.value = true })

/** 派发 */
const emit = defineEmits<{ (e: 'jump', file: string): void }>()
/**
 * 执行 jump To
 * @param f - f
 */
function jumpTo(f: string): void { emit('jump', f) }

/** 图标 */
const SEV_ICON: Record<Severity, string> = { error: '✗', warning: '⚠', info: '⋯' }

// [tier1c-3] 错误第一印象：一句话诊断 + 归因 + 行动建议 + 复现命令
interface Diagnosis {
  headline: string
  cause: string
  action: string
  command: string
}

/**
 * 执行 count Ts Errors
 * @param text - text
 */
function countTsErrors(text: string | undefined): number {
  if (!text) return 0
  return (text.match(/error TS\d+/g) || []).length
}

/** 诊断信息 */
const diagnosis = computed<Diagnosis | null>(() => {
  const list = items.value
  if (!list.length) return null
  const first = list[0]
  const r = props.result

  let headline = ''
  let cause = ''
  let action = ''
  let command = ''

  if (first.source === 'tsc') {
    const n = countTsErrors(r?.tsc?.stdout || r?.tsc?.stderr)
    headline = `类型检查失败${n ? `（${n} 处错误）` : ''}`
    cause = '类型系统不一致或缺少 import'
    action = '跑定向 tsc 复现，逐个修到 0 error'
    command = 'pnpm tsc'
  } else if (first.source === 'eslint') {
    headline = 'lint 规则违规'
    cause = '代码风格或项目禁则违规'
    action = '自动修一批，再人工看残留'
    command = 'pnpm lint:fix'
  } else if (first.source === 'test') {
    headline = '单元测试失败'
    cause = '行为变更未同步测试，或引入回归'
    action = '跑单测定位失败用例'
    command = 'pnpm test:unit'
  } else if (first.source === 'exit') {
    const code = r?.code
    if (code === 2) {
      headline = '安全熔断（exit 2）'
      cause = '触发契约校验或安全黑名单'
      action = '读 RULES 第三章与第七章；确认命令/路径合规'
    } else {
      headline = `脚本退出异常（exit ${String(code)}）`
      cause = '运行时异常或断言失败'
      action = '查看 stderr 首段定位'
    }
  } else if (first.source === 'errorFiles') {
    const n = (r?.errorFiles || []).length
    headline = `${n} 个文件涉及错误`
    cause = '变更引入的下游失败'
    action = '逐个打开排查或回退'
  } else {
    headline = `异常 ${list.length} 条`
    cause = '待归因'
    action = '查看明细'
  }

  return { headline, cause, action, command }
})

// 一键复制命令到剪贴板；不支持时退化到提示
/** 提示 */
const copiedTip = ref('')
/**
 * 复制 Command
 * @param cmd - cmd
 */
function copyCommand(cmd: string): void {
  try {
    if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
      void navigator.clipboard.writeText(cmd)
      copiedTip.value = `已复制: ${cmd}`
    } else {
      copiedTip.value = cmd
    }
  } catch {
    copiedTip.value = cmd
  }
  setTimeout(() => { copiedTip.value = '' }, 2000)
}

/**
 * 执行 jump First
 */
function jumpFirst(): void {
  const fs2 = props.result?.errorFiles
  if (fs2 && fs2.length) emit('jump', fs2[0])
}
</script>

<template>
  <div v-if="items.length" class="av">
    <div class="av-head" @click="expanded = !expanded">
      <span class="av-icon" :class="{ err: hasError }">{{ hasError ? '✗' : '⚠' }}</span>
      <span class="av-title">异常 {{ items.length }}</span>
      <span class="av-toggle">{{ expanded ? '收起' : '展开' }}</span>
    </div>
    <!-- [tier1c-3] 错误第一印象：先给结论、归因与行动 -->
    <div v-if="diagnosis" class="av-diag">
      <div class="av-diag-headline">
        {{ diagnosis.headline }}
      </div>
      <div class="av-diag-row">
        <span class="av-diag-label">归因</span>
        <span class="av-diag-text">{{ diagnosis.cause }}</span>
      </div>
      <div class="av-diag-row">
        <span class="av-diag-label">行动</span>
        <span class="av-diag-text">{{ diagnosis.action }}</span>
      </div>
      <div class="av-diag-actions">
        <button v-if="diagnosis.command" class="av-diag-btn" type="button" @click="copyCommand(diagnosis.command)">
          <span class="av-diag-cmd">{{ diagnosis.command }}</span>
        </button>
        <button v-if="props.result?.errorFiles && props.result.errorFiles.length" class="av-diag-btn" type="button" @click="jumpFirst()">
          → 首个错误文件
        </button>
        <span v-if="copiedTip" class="av-diag-tip">{{ copiedTip }}</span>
      </div>
    </div>
    <ul v-if="expanded" class="av-list">
      <li v-for="(it, i) in items" :key="i" class="av-item" :class="`av-${it.severity}`">
        <span class="av-sev">{{ SEV_ICON[it.severity] }}</span>
        <div class="av-body">
          <div class="av-source">
            {{ it.source }}
          </div>
          <pre class="av-msg">{{ it.message }}</pre>
          <div v-if="it.files && it.files.length" class="av-files">
            <a v-for="f in it.files" :key="f" class="av-file" @click="jumpTo(f)">{{ f }}</a>
          </div>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.av {
  margin: 8px 12px;
  border: 1px solid var(--border, #334155);
  border-radius: 6px;
  background: var(--surface, #1a1a1a);
  overflow: hidden;
}
.av-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  cursor: pointer;
  font-size: 11px;
  font-family: var(--mono, monospace);
}
.av-icon {
  font-size: 12px;
  color: #eab308;
}
.av-icon.err {
  color: #ef4444;
}
.av-title {
  flex: 1;
  color: var(--text-2, #cbd5e1);
}
.av-toggle {
  color: var(--text-3, #94a3b8);
  font-size: 10px;
}
.av-list {
  list-style: none;
  margin: 0;
  padding: 0 0 6px;
}
.av-item {
  display: flex;
  gap: 8px;
  padding: 6px 10px;
  border-top: 1px solid var(--border, #334155);
  font-family: var(--mono, monospace);
  font-size: 10px;
}
.av-sev {
  flex-shrink: 0;
  width: 12px;
}
.av-error .av-sev {
  color: #ef4444;
}
.av-warning .av-sev {
  color: #eab308;
}
.av-info .av-sev {
  color: #94a3b8;
}
.av-body {
  flex: 1;
  min-width: 0;
}
.av-source {
  color: var(--text-3, #94a3b8);
  margin-bottom: 2px;
}
.av-msg {
  margin: 0;
  padding: 4px 6px;
  background: var(--surface-2, #252525);
  border-radius: 3px;
  color: var(--text-2, #cbd5e1);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 120px;
  overflow: auto;
  font-size: 10px;
}
.av-files {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
.av-file {
  color: #3b82f6;
  cursor: pointer;
  font-size: 10px;
  padding: 1px 4px;
  background: var(--surface-2, #252525);
  border-radius: 3px;
}
.av-file:hover {
  text-decoration: underline;
}

/* [tier1c-3] 错误第一印象卡 */
.av-diag {
  padding: 8px 12px;
  border-top: 1px solid var(--border, #334155);
  background: var(--surface-2, #252525);
}
.av-diag-headline {
  font-weight: 600;
  font-size: 12px;
  color: #ef4444;
  margin-bottom: 6px;
  font-family: var(--mono, monospace);
}
.av-diag-row {
  display: flex;
  gap: 8px;
  margin-bottom: 3px;
  font-size: 11px;
  font-family: var(--mono, monospace);
}
.av-diag-label {
  flex-shrink: 0;
  width: 30px;
  color: var(--text-3, #94a3b8);
  text-align: right;
}
.av-diag-text {
  flex: 1;
  color: var(--text-2, #cbd5e1);
}
.av-diag-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 8px;
  flex-wrap: wrap;
}
.av-diag-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border: 1px solid var(--border-2, #333);
  border-radius: 4px;
  background: var(--surface-3, #2f2f2f);
  color: var(--text-2, #cbd5e1);
  font: 500 11px/1.4 var(--mono, monospace);
  cursor: pointer;
}
.av-diag-btn:hover {
  background: var(--surface-4, #3a3a3a);
  color: var(--text, #fff);
}
.av-diag-cmd {
  color: #3b82f6;
}
.av-diag-tip {
  font-size: 10px;
  color: var(--text-3, #94a3b8);
  font-family: var(--mono, monospace);
}
</style>
