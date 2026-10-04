<script setup lang="ts">
// PLAN 5.2 第四层：原始输出折叠
// 复用项目已有极简 markdown 渲染器（不引入新依赖）
// 事件流单例（localStorage 持久化），用于渲染每轮脚本 desc
// [rd-import-v1] 引入抽出的轮次分隔条组件
import RoundDivider from './RoundDivider.vue'
// [sc-wire-v1] 脚本卡片抽为子组件
import ScriptCard from './ScriptCard.vue'
// [timeline-denoise-v1] 长文本卡片的展开/收起入口
import FoldToggle from './FoldToggle.vue'
// [timeline-denoise-v1] 长文本预览 / 原始输出尾部折叠（纯函数，见 utils/timeline-preview.ts）
// [CONSTRAINT] 显式 import 而非依赖 auto-import：vitest 与 tsc 没有 auto-import 插件
import { clampTextPreview, tailTextPreview } from '../../utils/timeline-preview'

// [timeline-denoise-v1] 长文本卡片共用的「预览 + 折叠」字段
// [WHY] text / ask / done 三类卡片都要"超长才折叠"，字段同构可复用同一套折叠逻辑与样式
interface PreviewFields {
  /** 原文全文；展开后渲染 */
  text: string
  /** 截断后的预览；折叠态渲染（未超阈值时等于全文） */
  preview: string
  /** 是否超过阈值 —— 决定是否出现「展开全部」入口 */
  truncated: boolean
  /** 被折叠掉的整行数，用于「还有 N 行」文案 */
  hiddenLines: number
  /** 归一化后的原文总行数 */
  totalLines: number
}
interface ScriptItem {
  type: 'script'
  key: string
  langLabel: string
  phaseLabel: string
  phaseClass: string
  // desc 从 body 前移到 header，与 phase / time 同行展示
  desc: string
  timeLabel: string
  // [timeline-denoise-v1] 结果摘要：exit 码 / 变更文件数，让「跑成没、动了几个文件」一眼可见
  exit: number | null
  changeCount: number
  // [timeline-denoise-v1] 原始输出只保留尾部若干行，省略量显式标注（替代原先无提示的字符切片）
  stdoutText: string
  stdoutHidden: number
  stderrText: string
  stderrHidden: number
  // why 从卡片主体迁移至展开区，避免每张卡都占两行；空串表示无 why
  why: string
}
interface TextItem extends PreviewFields {
  type: 'text'
  key: string
  timeLabel: string
}
interface DoneItem extends PreviewFields {
  type: 'done'
  key: string
  timeLabel: string
}
// 用户提问/回答卡：ScriptPanel.runSmart 与 App.vue ask 回答分支 emit('ai:ask')
// role='user-answer' 时展示为「回答」+ answer-badge，区分于「提问」
interface AskItem extends PreviewFields {
  type: 'ask'
  key: string
  timeLabel: string
  role?: 'user-answer'
}
// [round-divider-v1] 轮次分隔条：loopRound 变化时插入，视觉上呈现 TRAE 式「轮次分组」
// [CONSTRAINT] 依赖 payload.loopRound（由 App.vue ...currentLoopContext() 注入）；手动模式无 loopRound → 不插条
interface DividerItem { type: 'round-divider', key: string, roundLabel: string, timeLabel: string }
// [ask-card-v1] AI 提问卡：@ask 不再弹窗，改为对话流里一张可点选/可打字的卡片
// [CONSTRAINT] askId 与 useAsk.askState.id 比对判断「是否仍可交互」——
//   历史遗留或已被新提问取代的卡片只读展示，防止误点后无人接收回答
interface QuestionItem extends PreviewFields {
  type: 'question'
  key: string
  timeLabel: string
  askId: string
  options: Array<{ id: string, label: string }>
  answered: boolean
  answer: string
}

/** 组件接收的 props 定义 */
const props = defineProps<{

  running: boolean
  // [tw-removed-v1] 原本接收打字机缓冲 twStdout/twStderr（useTwDisplay 逐字动画的产物）。
  // 该链唯一的消费点就是下方空态判定，逐字动画没有任何 UI 消费者 → 已整条删除；
  // 这里改为直接接 useRunner 的实时输出，语义从「打字机已播出多少」回归「有没有输出」。
  liveStdout: string
  liveStderr: string
  doneSummary?: string
  // 等待 AI 回复中；由 ScriptPanel 透传 useAiWaiting().waiting
  aiWaiting?: boolean
}>()

/** 阶段中文标签表；未命中回退为原值 */
const PHASE_LABEL: Record<string, string> = {
  pending: '等待执行',
  running: '执行中',
  done: '已完成',
  error: '失败',
}
// [timeline-denoise-v1] 长文本折叠阈值：刻意宽松 —— 常规总结 / 短回复完全不折叠，
//   只挡真正的"文字墙"（AI 长散文、含附件全文的用户 prompt、压缩 JSON）。
// [CONSTRAINT] 三档差异体现「用户预期」：用户自己的提问只需扫一眼开头；
//   AI 的中间回复稍放宽；任务总结是最终交付物，给到最宽阈值，避免误折真正要读的内容。
const TEXT_PREVIEW = { lines: 12, chars: 800 }
const ASK_PREVIEW = { lines: 6, chars: 400 }
const DONE_PREVIEW = { lines: 30, chars: 3000 }
// [timeline-denoise-v1] 脚本卡原始输出的保留策略（与 useRunner 的 slice(-400) 对齐）
const TAIL_KEEP_LINES = 5
const TAIL_MAX_CHARS = 400
/** 阶段类名 → 是否属于终态（用于进度条统计，避免散落字面量） */
const PHASE_DONE_CLASS = 'phase-done'
const PHASE_ERROR_CLASS = 'phase-error'
// [terminal-md-cache-removed-v1] 本地 _mdCache 已冗余：renderMarkdown（useMarkdown）
// 现已内置模块级 LRU 缓存，所有调用点共享同一份，无需在组件内重复实现。
const renderMarkdownCached = renderMarkdown

// 等待时长本地计时：aiWaiting 为 true 时启动，false 时停止并归零
// [WHY] 用本地 interval 而非改 useAiWaiting 契约（避免污染其他消费方）；仅用于展示层
// [CONSTRAINT] useIntervalFn 组件卸载自动清理；watch 双向同步启停
// [CHANGE-IMPACT] 与 wait-banner 模板成对；去掉 watch 会让秒数永远为 0
const waitElapsed = ref(0)
// [sc-deadcode-v1] 脚本卡的 expanded/toggle 已下沉到 ScriptCard.vue（各自持有展开态）
// [timeline-denoise-v1] 长文本卡片（text / ask / done）的展开态：按卡片 key 记录，
//   不在集合中即为折叠态（默认折叠）；与脚本卡的展开态互不影响
const expandedCards = ref<Set<string>>(new Set())
/** 列表 */
const chatListRef = ref<HTMLElement | null>(null)
/** 各提问卡的自由输入草稿；[CONSTRAINT] 按卡片 key 分桶，多张历史卡片互不串味 */
const askDrafts = ref<Record<string, string>>({})

const { events: busEvents } = useEventBus()
// [ask-card-v1] 当前活跃提问（单例）；用于判断某张提问卡是否仍可点选
const { askState, resolveAsk } = useAsk()
const { pause: pauseWaitTimer, resume: resumeWaitTimer } = useIntervalFn(() => {
  waitElapsed.value += 1
}, 1000, { immediate: false })

/**
 * 每轮脚本卡片：从 busEvents 提取 run:start 事件（desc/why/lang/phase）
 * [WHY] 事件流 updateKey 原地更新，同一脚本多次 phase 变化只留一条；desc 用 renderMarkdown 呈现
 * [CONSTRAINT] 仅收 payload.desc 或 summary 非空的事件；无内容的不渲染，避免空卡
 * [CHANGE-IMPACT] 依赖 App.vue / useRunner 的 emit 契约（run:start + payload.desc/why/lang/phase）
 * [timeline-denoise-v1] 长文本一律先给预览（clampTextPreview），脚本原始输出只留尾部若干行
 *   （tailTextPreview）；折叠判定在数据层完成，模板只读 truncated/hiddenLines，避免渲染期计算
 */
const timelineItems = computed(() => {
  const out: Array<ScriptItem | TextItem | DoneItem | AskItem | QuestionItem | DividerItem> = []
  // [round-divider-v1] 追踪上一张脚本卡的轮次；跨轮时插入分隔条（初始 0 表示尚未出现任何轮次）
  let lastRound = 0
  for (const ev of busEvents.value) {
    // [ask-card-v1] AI 提问卡：@ask 解析结果，渲染为对话流内可点选/可打字的卡片（替代旧弹窗）
    // [CONSTRAINT] 正文与选项皆空才跳过；只要有一项就渲染（纯选项问题也合法）
    // [CHANGE-IMPACT] 依赖 useAsk.askUser emit 的 payload 契约（askId/question/options/answered/answer）
    if (ev.kind === 'ai:question') {
      const tp = (ev.payload || {}) as Record<string, unknown>
      const question = String(tp.question || '').trim()
      const options = normalizeAskOptions(tp.options)
      if (!question && options.length === 0) continue
      // [timeline-denoise-v1] 提问常夹带代码/长正文，阈值取与用户提问同档的严标准
      const pv = clampTextPreview(question, ASK_PREVIEW.lines, ASK_PREVIEW.chars)
      out.push({
        type: 'question',
        key: `question-${ev.id}`,
        timeLabel: hmsLabel(Number(tp.askedAt) || ev.ts),
        askId: String(tp.askId || ''),
        options,
        answered: tp.answered === true,
        answer: String(tp.answer || ''),
        text: question,
        ...pv,
      })
      continue
    }
    // 用户提问卡：ScriptPanel.runSmart 成功 copyAndFill 后 emit('ai:ask')
    // [CONSTRAINT] 只收 payload.text 非空事件，避免空卡；与 ai:done 同结构仅 badge 不同
    if (ev.kind === 'ai:ask') {
      const tp = (ev.payload || {}) as Record<string, unknown>
      const text = String(tp.text || '').trim()
      if (!text) continue
      // [timeline-denoise-v1] 提问常携带附件全文（数千行），阈值取最严的一档
      const pv = clampTextPreview(text, ASK_PREVIEW.lines, ASK_PREVIEW.chars)
      // role 分流：'user-answer' 走回答卡样式；缺省按提问卡
      out.push({
        type: 'ask',
        key: `ask-${ev.id}`,
        timeLabel: hmsLabel(ev.ts),
        text,
        ...pv,
        ...(tp.role === 'user-answer' ? { role: 'user-answer' as const } : {}),
      })
      continue
    }
    // 总结卡片：来自 ai:done 事件（方案 A，持久化）
    // [CONSTRAINT] text 为空表示纯占位（AI 只回复 DONE 无总结），跳过不渲染
    if (ev.kind === 'ai:done') {
      const tp = (ev.payload || {}) as Record<string, unknown>
      const text = String(tp.text || '').trim()
      if (!text) continue
      // [timeline-denoise-v1] 总结是最终交付物 —— 阈值最宽，不误折用户真正要读的内容
      const pv = clampTextPreview(text, DONE_PREVIEW.lines, DONE_PREVIEW.chars)
      out.push({ type: 'done', key: `done-${ev.id}`, timeLabel: hmsLabel(ev.ts), text, ...pv })
      continue
    }
    // 非 cjs 文本（ai:plain / ai:multi）按时间顺序混排为 Markdown 卡片
    // [CONSTRAINT] 只收 payload.text 非空的事件
    if (ev.kind === 'ai:plain' || ev.kind === 'ai:multi') {
      const tp = (ev.payload || {}) as Record<string, unknown>
      const text = String(tp.text || '').trim()
      if (!text) continue
      const pv = clampTextPreview(text, TEXT_PREVIEW.lines, TEXT_PREVIEW.chars)
      out.push({ type: 'text', key: `text-${ev.id}`, timeLabel: hmsLabel(ev.ts), text, ...pv })
      continue
    }
    if (ev.kind !== 'run:start') continue
    const p = (ev.payload || {}) as Record<string, unknown>
    const desc = String(p.desc || '').trim()
    const why = String(p.why || '').trim()
    const lang = String(p.lang || 'js')
    const phase = String(p.phase || 'running')
    const key = String(p.updateKey || `ev-${ev.id}`)
    // 跳过旧事件（payload 无 why 且 desc 为默认值）产生的空卡
    if (!why && (!desc || desc === '执行脚本')) continue
    // desc 不再走 body markdown；直接作为 header 文本字段
    const langLabel = lang === 'bash' ? 'BASH' : lang === 'cjs' ? 'CJS' : 'JS'
    const timeLabel = hmsLabel(ev.ts)
    // [timeline-denoise-v1] 原始输出折叠：只留尾部若干行，省略量由卡片显式标注
    // [WHY] 原实现对 payload.stdoutTail 原样展示且无省略提示，安装/构建类输出会整段刷屏
    const outTail = tailTextPreview(String(p.stdoutTail || ''), TAIL_KEEP_LINES, TAIL_MAX_CHARS)
    const errTail = tailTextPreview(String(p.stderrTail || ''), TAIL_KEEP_LINES, TAIL_MAX_CHARS)
    // [round-divider-v1] loopRound 变化时插一条轮次分隔（不改变原有卡片结构，纯视觉分组）
    const loopRoundNum = Number(p.loopRound || 0)
    if (loopRoundNum > 0 && loopRoundNum !== lastRound) {
      lastRound = loopRoundNum
      out.push({ type: 'round-divider', key: `rd-${loopRoundNum}-${ev.id}`, roundLabel: `R${loopRoundNum}`, timeLabel })
    }
    out.push({
      type: 'script',
      key,
      langLabel,
      phaseLabel: PHASE_LABEL[phase] || phase,
      phaseClass: `phase-${phase}`,
      desc,
      timeLabel,
      // [timeline-denoise-v1] 结果摘要：exit / 变更文件数随终态事件下发（useRunner.wrappedEmitStep）
      exit: typeof p.exit === 'number' ? p.exit : null,
      changeCount: Number(p.changeCount || 0),
      stdoutText: outTail.text,
      stdoutHidden: outTail.hiddenLines,
      stderrText: errTail.text,
      stderrHidden: errTail.hiddenLines,
      why,
    })
  }

  return out
})
// [script-progress-v1] 任务进度：完成与失败分开统计，模板据此显示「已完成 N/M · 失败 K」
// [WHY] 原实现把 error 计入 done，用户看到「7/7 tasks completed」却混着失败步骤，
//   与预期不符；拆开后进度条仍按终态合计推进，语义与视觉都不丢信息
// [CONSTRAINT] 只统计当前 timelineItems 中的脚本卡；随清屏 / 刷新同步更新
// [CHANGE-IMPACT] 与模板 .progress-header 成对；去掉会让顶部进度消失
const scriptProgress = computed(() => {
  const items = timelineItems.value.filter(c => c.type === 'script') as Array<{ phaseClass: string }>
  let done = 0
  let failed = 0
  for (const c of items) {
    if (c.phaseClass === PHASE_DONE_CLASS) done += 1
    else if (c.phaseClass === PHASE_ERROR_CLASS) failed += 1
  }
  return { done, failed, finished: done + failed, total: items.length }
})

watch(() => props.aiWaiting, (v) => {
  if (v) { waitElapsed.value = 0; resumeWaitTimer() }
  else { pauseWaitTimer(); waitElapsed.value = 0 }
}, { immediate: true })
// 总结写入后自动滚到底部，确保用户第一眼看到
// [CONSTRAINT] 需 nextTick 等 DOM 更新完成后再滚；仅当有新内容时触发（props.doneSummary 从空→非空 或 变内容）
// [CHANGE-IMPACT] 若父组件清空 doneSummary（新一轮开始）不滚动；避免滚动位置抖动
watch(
  () => [props.doneSummary, timelineItems.value.length] as const,
  async ([v]) => {
    if (!v && timelineItems.value.length === 0) return
    await nextTick()
    const el = chatListRef.value
    if (el) el.scrollTop = el.scrollHeight
  },
)

// 页面刷新时自动滚到最后一条：
// [WHY] 上面的 watch 非 immediate，刷新时 busEvents 若同步恢复则不触发；需挂载后主动滚一次
// [CONSTRAINT] rAF 二次滚动兜底字体/异步渲染造成的高度变化；一次性，不持续 watch
// [CHANGE-IMPACT] 与上面的 watch 互补：watch 管运行时新增，onMounted 管首次挂载
onMounted(async () => {
  await nextTick()
  // 连续 3 帧滚动：兜底字体/异步渲染/图片导致的高度变化
  for (let i = 0; i < 3; i++) {
    requestAnimationFrame(() => {
      const el = chatListRef.value
      if (el) el.scrollTop = el.scrollHeight
    })
  }
})

/**
 * 事件时刻 → HH:MM:SS 本地时间标签
 * [WHY] 原实现在 ask / done / text 三处各写一份 pad + timeLabel 闭包，格式变更要改三处
 * @param ts 事件时间戳（毫秒）；缺省取当前时刻
 */
function hmsLabel(ts?: number): string {
  const d = new Date(ts || Date.now())
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
/**
 * 切换长文本卡片的展开态
 * [CONSTRAINT] Set 必须整体替换才触发响应式更新（与 treeExpanded 同惯例）
 */
function toggleCard(key: string): void {
  const next = new Set(expandedCards.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expandedCards.value = next
}
/**
 * 选择长文本卡片的渲染内容：折叠态给预览、展开态给全文
 * [WHY] 不预渲染 html 字段：折叠态下若把全文也 renderMarkdown 一遍，长回复会白白付一次解析成本
 *   （renderMarkdown 自带 LRU 缓存，此处按文本命中，重复渲染成本仅为一次查表）
 * [CONSTRAINT] 依赖 expandedCards；模板中调用，展开态切换即重新求值
 */
function cardHtml(card: PreviewFields & { key: string }): string {
  const collapsed = card.truncated && !expandedCards.value.has(card.key)
  return renderMarkdownCached(collapsed ? card.preview : card.text)
}
/**
 * 规整事件 payload 里的选项数组
 * [WHY] 事件经 localStorage 反序列化后类型退化为 unknown，模板直接消费不安全
 * [CONSTRAINT] 缺 label 的项丢弃；id 缺失时按序号补位，保证 :key 稳定
 * @param raw 事件 payload.options 原值
 */
function normalizeAskOptions(raw: unknown): Array<{ id: string, label: string }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ id: string, label: string }> = []
  for (const item of raw) {
    const o = (item || {}) as Record<string, unknown>
    const label = String(o.label ?? '').trim()
    if (!label) continue
    out.push({ id: String(o.id || `opt_${out.length + 1}`), label })
  }
  return out
}
/**
 * 该提问卡是否仍可交互
 * [WHY] 已答 / 被新提问取代 / 页面刷新（Promise 已丢失）三种情况都不可再提交，
 *   否则用户点完无人接收，看起来像"点了没反应"
 * @param card 提问卡
 */
function isAskActive(card: QuestionItem): boolean {
  return !card.answered && Boolean(card.askId) && askState.value?.id === card.askId
}
/**
 * 提交提问卡的回答（按钮点选与自由输入共用同一出口）
 * [CONSTRAINT] 空文本与失效卡片一律忽略；提交前清空该卡草稿
 */
function submitAskAnswer(card: QuestionItem, text: string): void {
  const t = String(text || '').trim()
  if (!t || !isAskActive(card)) return
  askDrafts.value = { ...askDrafts.value, [card.key]: '' }
  resolveAsk(t)
}
/**
 * 更新某张提问卡的输入草稿
 * [WHY] 不用 v-model 绑定 `askDrafts[key]`（动态成员表达式），显式事件更利于类型检查与守卫测试
 * [CONSTRAINT] Set 语义整体替换，与 expandedCards 同惯例
 */
function onAskInput(key: string, e: Event): void {
  const value = (e.target as HTMLInputElement | null)?.value || ''
  askDrafts.value = { ...askDrafts.value, [key]: value }
}
</script>

<template>
  <section class="terminal">
    <!-- [flow-timeline] 全流程时间线 -->
    <div class="flow-timeline">
      <!-- [script-progress-v1] 顶部进度：完成与失败分开显示；无脚本卡时不渲染 -->
      <div v-if="scriptProgress.total > 0" class="progress-header">
        <span class="progress-dot" :class="{ 'is-active': scriptProgress.finished < scriptProgress.total }" />
        <span class="progress-text">
          已完成 {{ scriptProgress.finished }}/{{ scriptProgress.total }} 步
        </span>
        <span v-if="scriptProgress.failed > 0" class="progress-failed">
          失败 {{ scriptProgress.failed }}
        </span>
        <span class="progress-bar">
          <span
            class="progress-bar-fill"
            :style="{ width: `${scriptProgress.total ? (scriptProgress.finished / scriptProgress.total * 100) : 0}%` }"
          />
        </span>
      </div>
      <div ref="chatListRef" class="chat-list">
        <!-- 每轮脚本 desc：Markdown 渲染；来源 busEvents（已持久化到 localStorage） -->
        <template v-for="card in timelineItems" :key="card.key">
          <!-- [rd-tpl-v1] 已抽为子组件 -->
          <RoundDivider
            v-if="card.type === 'round-divider'"
            :round-label="card.roundLabel"
            :time-label="card.timeLabel"
          />
          <ScriptCard
            v-else-if="card.type === 'script'"
            :key="card.key"
            :card="card"
          />
          <section v-else-if="card.type === 'done'" class="done-summary">
            <div class="done-summary-head">
              任务完成 · 总结
            </div>
            <div class="done-summary-body" v-html="cardHtml(card)" />
            <!-- [timeline-denoise-v1] 超长总结默认折叠，避免"文字墙"淹没结论 -->
            <FoldToggle
              v-if="card.truncated"
              :expanded="expandedCards.has(card.key)"
              :hidden-lines="card.hiddenLines"
              @toggle="toggleCard(card.key)"
            />
          </section>
          <!-- 非 cjs 文本卡片：与总结同排版 -->
          <section v-else-if="card.type === 'text'" class="text-card">
            <header class="text-card-head">
              <span class="text-card-badge">AI</span>
              <span class="script-card-time">{{ card.timeLabel }}</span>
            </header>
            <div class="done-summary-body" v-html="cardHtml(card)" />
            <FoldToggle
              v-if="card.truncated"
              :expanded="expandedCards.has(card.key)"
              :hidden-lines="card.hiddenLines"
              @toggle="toggleCard(card.key)"
            />
          </section>
          <!-- 用户提问/回答卡：badge 用「你」区分 AI；回答额外走 answer-card 视觉 -->
          <section v-else-if="card.type === 'ask'" class="text-card" :class="card.role === 'user-answer' ? 'answer-card' : 'ask-card'">
            <header class="text-card-head">
              <span class="text-card-badge" :class="card.role === 'user-answer' ? 'answer-badge' : 'ask-badge'">你</span>
              <span class="script-card-time">{{ card.timeLabel }}</span>
            </header>
            <div class="done-summary-body" v-html="cardHtml(card)" />
            <FoldToggle
              v-if="card.truncated"
              :expanded="expandedCards.has(card.key)"
              :hidden-lines="card.hiddenLines"
              @toggle="toggleCard(card.key)"
            />
          </section>
          <!-- [ask-card-v1] AI 提问卡：替代旧弹窗，直接渲染在对话流里，可点选也可自由输入 -->
          <section
            v-else-if="card.type === 'question'"
            class="question-card"
            :class="{ 'is-answered': card.answered, 'is-stale': !card.answered && !isAskActive(card) }"
          >
            <header class="text-card-head">
              <span class="text-card-badge question-badge">ASK</span>
              <span class="script-card-time">{{ card.timeLabel }}</span>
              <span v-if="card.answered" class="question-state">已回答</span>
              <span v-else-if="!isAskActive(card)" class="question-state is-stale">已失效</span>
            </header>
            <div v-if="card.text" class="done-summary-body" v-html="cardHtml(card)" />
            <FoldToggle
              v-if="card.truncated"
              :expanded="expandedCards.has(card.key)"
              :hidden-lines="card.hiddenLines"
              @toggle="toggleCard(card.key)"
            />
            <div v-if="card.options.length" class="question-options">
              <button
                v-for="o in card.options" :key="o.id"
                class="question-opt" type="button"
                :disabled="!isAskActive(card)"
                @click="submitAskAnswer(card, o.label)"
              >
                {{ o.label }}
              </button>
            </div>
            <div v-if="card.answered" class="question-answer">
              你的回答：{{ card.answer || '（已取消）' }}
            </div>
            <form
              v-else-if="isAskActive(card)"
              class="question-input-row"
              @submit.prevent="submitAskAnswer(card, askDrafts[card.key])"
            >
              <input
                class="question-input"
                :value="askDrafts[card.key] || ''"
                :placeholder="card.options.length ? '或输入自定义回答…' : '输入你的回答…'"
                @input="onAskInput(card.key, $event)"
              >
              <button
                class="question-send" type="submit"
                :disabled="!(askDrafts[card.key] || '').trim()"
              >
                发送
              </button>
            </form>
            <div v-else class="question-stale">
              此提问已失效（已被新的提问取代，或页面已刷新）
            </div>
          </section>
        </template>

        <!-- 空态：无卡片 / 无输出 / 无总结 -->
        <div v-if="!running && !liveStdout && !liveStderr && timelineItems.length === 0" class="tree-empty">
          <div class="empty-title">
            还没有执行记录
          </div>
          <div class="empty-sub">
            点击「运行」开始自动化循环
          </div>
        </div>
      </div>
      <!-- 等待 AI 回复指示条：收到首个回复后由 stopAiWaiting 关闭；置于消息流底部 -->
      <div v-if="props.aiWaiting" class="wait-banner" role="status" aria-live="polite">
        <span class="wait-spinner" aria-hidden="true" />
        <span class="wait-text">{{ waitElapsed >= 30 ? 'AI 仍在处理' : 'AI 思考中' }}</span>
        <span class="wait-dots" aria-hidden="true" />
        <span v-if="waitElapsed > 0" class="wait-elapsed" aria-hidden="true">{{ waitElapsed }}s</span>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss" src="./terminal-pane.scss"></style>
