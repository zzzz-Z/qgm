<script setup lang="ts">
// PLAN 5.2 异常视图：本轮异常聚合 + 按严重度排序 + 默认隐藏
import { computed, ref, watch } from 'vue'
import { useClipboard } from '@vueuse/core'

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
type Severity = 'error' | 'warning' | 'info'
interface Item {
  severity: Severity
  source: string
  message: string
  files?: string[]
}
// [tier1c-3] 错误第一印象：一句话诊断 + 归因 + 行动建议 + 复现命令
interface Diagnosis {
  headline: string
  cause: string
  action: string
  command: string
}

/** 向父组件派发"跳转到错误文件"事件（父组件负责选中/滚动） */
const emit = defineEmits<{ (e: 'jump', file: string): void }>()

/** 上一轮运行结果；null 表示尚未运行，各子字段可能缺失由下方诊断逻辑兜底 */
const props = withDefaults(defineProps<Props>(), { result: null })
/** 严重度排序权重；[CHANGE-IMPACT] items 排序依赖此映射，改权重会改变 UI 首条展示项 */
const severityOrder: Record<Severity, number> = { error: 0, warning: 1, info: 2 }
/** 严重度 → 展示图标；[CONSTRAINT] 三种 Severity 必须全覆盖，否则模板渲染 undefined */
const SEV_ICON: Record<Severity, string> = { error: '✗', warning: '⚠', info: '⋯' }

/** 列表展开态；有 error 时会被下方 watch 强制置 true */
const expanded = ref(false)
// 一键复制命令到剪贴板；不支持时退化到提示
/** 复制按钮的临时提示文案（"已复制: xxx" 或降级显示的原始命令）；2s 后自动清空 */
const copiedTip = ref('')

// [copy-via-vueuse] 组件级单例 useClipboard：内部会注册 copy 事件监听，
// 通过 setup scope 在组件卸载时自动清理；因此必须定义在 setup 顶层而非函数内
const _clipboard = useClipboard()

/** 汇总所有异常源（tsc / eslint / test / exit / errorFiles）并按严重度排序 */
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
/** 是否至少有一条 error 级条目；决定头部图标用红叉还是黄叹号 */
const hasError = computed(() => items.value.some(i => i.severity === 'error'))
/** [tier1c-3] 一句话诊断：取最严重条目生成 归因 / 行动 / 复现命令 四段式；无异常时返回 null */
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

// 有 error 时自动展开
watch(items, (v) => { if (v.some(i => i.severity === 'error')) expanded.value = true })

/**
 * 取文本前 n 行（跳过空行）
 * [WHY] stderr / tsc 输出常有前后空行；空白跳过可让摘要直接从错误行开始
 * [CONSTRAINT] undefined / 空串返回空字符串，调用方需自行提供默认文案
 * @param text 源文本；可为 undefined
 * @param n 保留的非空行数量
 */
function firstLines(text: string | undefined, n: number): string {
  if (!text) return ''
  const ls = text.split('\n').filter(Boolean)
  return ls.slice(0, n).join('\n')
}
/**
 * 请求父组件跳转到指定文件
 * [CONSTRAINT] 纯事件转发，不校验路径存在性；父组件负责失败提示
 * @param f 目标文件相对路径
 */
function jumpTo(f: string): void { emit('jump', f) }
/**
 * 统计 tsc 输出中 `error TS####` 的出现次数
 * [CONSTRAINT] 依赖 tsc 固定错误格式；改 format 会导致漏计（此处不兜底）
 * [WHY] 用于在诊断卡片头部展示精确错误数，比"失败"更具体
 * @param text tsc stdout 或 stderr；undefined 返回 0
 */
function countTsErrors(text: string | undefined): number {
  if (!text) return 0
  return (text.match(/error TS\d+/g) || []).length
}
/**
 * 复制命令到剪贴板并给出 2s 临时反馈
 * [copy-via-vueuse] 走 vueuse useClipboard：内部自动选 navigator.clipboard 或 execCommand 回退，
 * 组件卸载时自动解绑 copy 监听
 * [CONSTRAINT] 复制失败时降级为展示命令原文，让用户手动选择复制（不弹错）
 * [CHANGE-IMPACT] 顶部 copiedTip 由定时器自动清空，频繁点击会延续显示（不主动 clearTimeout，与原行为一致）
 * @param cmd 需要复制的命令行文本
 */
async function copyCommand(cmd: string): Promise<void> {
  try {
    await _clipboard.copy(cmd)
    copiedTip.value = `已复制: ${cmd}`
  } catch {
    copiedTip.value = cmd
  }
  setTimeout(() => { copiedTip.value = '' }, 2000)
}
/**
 * 跳转到首个 errorFiles 条目
 * [CONSTRAINT] errorFiles 为空时静默 no-op（模板已用 v-if 兜底按钮可见性）
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
