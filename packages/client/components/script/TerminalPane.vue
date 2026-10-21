<script setup lang="ts">
// PLAN 5.2 第四层：原始输出折叠
// 复用项目已有极简 markdown 渲染器（不引入新依赖）
// 事件流单例（localStorage 持久化），用于渲染每轮脚本 desc
// [rd-import-v1] 引入抽出的轮次分隔条组件
import TaskProgressPanel from './TaskProgressPanel.vue'
// [panel-resize-scroll-v1] D4：面板尺寸变化时补偿 chat-list scrollTop，防贴底跳变
// [sc-wire-v1] 脚本卡片抽为子组件
import ScriptCard from './ScriptCard.vue'
// [timeline-denoise-v1] 长文本卡片的展开/收起入口
// [round-card-v1] done / text / ask / question 四类卡片抽为子组件
import RoundCard from './RoundCard.vue'
// [timeline-denoise-v1] 长文本预览 / 原始输出尾部折叠（纯函数，见 utils/timeline-preview.ts）
// [CONSTRAINT] 显式 import 而非依赖 auto-import：vitest 与 tsc 没有 auto-import 插件
import { clampTextPreview, denoiseLog, tailTextPreview, unfoldEscapedLog } from '../../utils/timeline-preview'
// [strip-script-blocks-v1] 剥离误分类进 plain 的脚本围栏块（消除脚本正文渲染成文本卡的噪音）
import { stripScriptBlocks } from '../../utils/strip-script-blocks'
// [preview-ssot-v1] 预览阈值统一定义在 timeline-build（单一定义，防两处分叉）
// [turn-block-frame-v1] buildOneCard 亦从该模块引入：块帧建卡规则只有一份，本组件不再内联复写
import { ASK_PREVIEW, buildOneCard, DONE_PREVIEW, TAIL_KEEP_LINES, TAIL_MAX_CHARS, TEXT_PREVIEW } from '../../utils/timeline-build'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRuntime } from '../../composables/ai/useRuntime'
// [phase-clock-v1] AI 阶段文案与秒表（模块级单例）：AI 思考中 / AI 仍在处理 / 回传中
import { useAiPhaseClock } from '../../composables/ai/useAiPhaseClock'
import { useToast } from '../../composables/ui/useToast'
import { TOAST_MEDIUM, TOAST_SHORT } from '../../utils/toast-durations'
import { useEventBus } from '../../composables/ui/event-stream'
// [eventbus-name-clash-v1] 显式 import（原因同 ScriptPanel.vue）
// [terminal-actions-v1] 显式 import：本组件此前无 toast 调用，auto-import 在 vitest/tsc 下不生效
// [runtime-kind-ssot-v1] 等待 banner 的判据改读运行态单一真相源（不再由父级透传 props）

// [timeline-denoise-v1] 长文本卡片共用的「预览 + 折叠」字段
// [WHY] text / ask / done 三类卡片都要"超长才折叠"，字段同构可复用同一套折叠逻辑与样式
// [no-fold-full-text-v1] 折叠入口已下线（用户 2026-10-21：「删除展开全部 默认就全部展示」）：
//   本结构仍在算 preview/truncated（纯函数、无副作用），但 RoundCard 只读 text ——
//   保留字段是为了不动 4 个调用点的对象字面量形状，语义上它们已是「历史字段」。
interface PreviewFields {
  /** 原文全文；卡片的唯一渲染源 */
  text: string
  /** 历史字段：折叠时代的截断预览，现已不参与渲染 */
  preview: string
  /** 历史字段：是否超阈值（曾决定是否出现「展开全部」入口，入口已删） */
  truncated: boolean
  /** 历史字段：被折叠掉的整行数 */
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
  // [script-card-changes-v1] 本次执行变更文件列表
  changes: Array<{ path: string, type: string }>
  // [timeline-denoise-v1] 原始输出只保留尾部若干行，省略量显式标注（替代原先无提示的字符切片）
  stdoutText: string
  stdoutHidden: number
  stderrText: string
  stderrHidden: number
  // [script-card-head-v2] why 回到卡片头部（desc 下方第二行常显）：它是「这一步为什么做」，
  //   与 desc 同属步骤属性而非输出；藏在展开区里等于要求用户逐行点开才能理解意图。
  //   空串表示无 why（旧事件 payload 无此字段）。
  why: string
  // [card-duration-v1] 本轮执行耗时（ms）；终态事件才带值，运行中为 null
  durationMs: number | null
  // [script-card-reason-v1] 失败原因：useRunner 的 error 分支会带 payload.reason
  //   （「未收到 summary 帧」/「已取消」/异常文本）。此前该字段存在但从未渲染，
  //   用户只能靠被截断的 stderr 尾去猜。空串表示无（成功态恒为空）。
  reason: string
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
// [ask-card-v1] AI 提问卡：ASK 不再弹窗，改为对话流里一张可点选/可打字的卡片
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
/**
 * 每轮脚本卡片：从 busEvents 提取 run:start 事件（desc/why/lang/phase）
 * [WHY] 事件流 updateKey 原地更新，同一脚本多次 phase 变化只留一条；desc 用 renderMarkdown 呈现
 * [CONSTRAINT] 仅收 payload.desc 或 summary 非空的事件；无内容的不渲染，避免空卡
 * [CHANGE-IMPACT] 依赖 App.vue / useRunner 的 emit 契约（run:start + payload.desc/why/lang/phase）
 * [timeline-denoise-v1] 长文本一律先给预览（clampTextPreview），脚本原始输出只留尾部若干行
 *   （tailTextPreview）；折叠判定在数据层完成，模板只读 truncated/hiddenLines，避免渲染期计算
 */
// [ui-p2c-stable-ref-v1] V9 判据①核心：卡对象引用稳定化。
// [WHY] computed 每次重算都新建全部卡对象 → v-for 里所有子组件的 props.card 引用变化，
//   触发全量 updated（无论内容是否真的变了）；判据①「单事件重渲染卡数 ≤ 3」因此不达标。
//   本函数把内容等价的卡替换回上一次的对象引用，v-for 命中同 key + 同 props 时不再触发 updated。
// [CONSTRAINT] 必须组件内私有 cache；浅比较（字段全等 + 数组用 JSON 串）足够，卡字段均为原始类型/纯数组。
// [CHANGE-IMPACT] 若误用「长寿命外部 cache」会跨组件实例泄漏，务必保持本声明。
type AnyCard = ScriptItem | TextItem | DoneItem | AskItem | QuestionItem

/** 组件接收的 props 定义 */
const props = defineProps<{

  running: boolean
  // [tw-removed-v1] 原本接收打字机缓冲 twStdout/twStderr（useTwDisplay 逐字动画的产物）。
  // 该链唯一的消费点就是下方空态判定，逐字动画没有任何 UI 消费者 → 已整条删除；
  // 这里改为直接接 useRunner 的实时输出，语义从「打字机已播出多少」回归「有没有输出」。
  liveStdout: string
  liveStderr: string
  doneSummary?: string
  // [status-bar-move-v1] 顶部阶段条迁到时间线底部：状态由 ScriptPanel 传入。
  // [status-bar-inline-v2] 阶段条只渲染 AI 阶段（runtimeKind + useAiPhaseClock 的「AI 思考中」）；
  //   statusText/statusClass/statusElapsed/runCount/tokenLabel 已不上屏，prop 接线保留以维持
  //   script-panel-guards 的「ScriptPanel→TerminalPane 状态链」判据（后续裁剪须同步改守卫）。
  statusText?: string
  statusClass?: string
  statusKind?: string
  statusElapsed?: string
  runCount?: number
  tokenLabel?: string
}>()
// [script-card-changes-v1] 冒泡 ScriptCard 的预览点击 → 由 ScriptPanel 打开浮层
// [terminal-actions-v1] stop：终端「关闭进程」按钮与 Esc 快捷键向父级冒泡，复用 useRunner.stop
const emit = defineEmits<{ preview: [path: string], stop: [] }>()

const _copiedTimer: ReturnType<typeof setTimeout> | null = null
/** 阶段中文标签表；未命中回退为原值 */
const PHASE_LABEL: Record<string, string> = {
  pending: '等待执行',
  running: '执行中',
  done: '已完成',
  error: '失败',
}
// 总结写入后自动滚到底部，确保用户第一眼看到
// [CONSTRAINT] 需 nextTick 等 DOM 更新完成后再滚；仅当有新内容时触发（props.doneSummary 从空→非空 或 变内容）
// [CHANGE-IMPACT] 若父组件清空 doneSummary（新一轮开始）不滚动；避免滚动位置抖动
// [scroll-snap-v3] 方向敏感 + 精确到底：
//   向上滚（cur < last）→ 立即停吸，不看距离 —— 用户想读历史就给静态视图
//   精确到底（距底 <= 8px）→ 恢复吸附 —— 只在真到底时才自动跟随
//   向下滚但未到底 → 保持现状 —— 不因接近底部误吸附
// [WHY] v2 只判距离，用户在阈值内轻微上翻仍被拽回；方向敏感后不存在此窗口。
// [CONSTRAINT] atBottom 由 chat-list 的 scroll 事件维护；lastScrollTop 是方向判据。
// [CHANGE-IMPACT] 模板已加 @scroll；去掉会让吸附失效。
const BOTTOM_THRESHOLD_PX = 8
let lastScrollTop = 0
const _cardCache = new Map<string, AnyCard>()
const _seenScriptKeys = new Set<string>()
// [panel-resize-scroll-v1] D4：面板高度变化（出现 / 消失 / 折叠）时补偿 chat-list scrollTop
// [WHY] 面板在 chat-list 上方，其高度变化侵占/释放 chat-list 空间；
//   用户此前已贴底时会出现「视觉位置跳变」；按 delta 平移 scrollTop 保持视觉稳定
// [CONSTRAINT] 仅当「用户此前处于贴底」时才补偿；否则尊重用户当前阅读位置不动
// [CHANGE-IMPACT] 不改变 force-scroll-on-script-start-v1 语义（该逻辑仍独立）
let _lastPanelHeight = 0
let _panelRo: ResizeObserver | null = null
let _innerRo: ResizeObserver | null = null
/**
 * [ui-empty-guide-v2] 空态引导是否已看过（localStorage 持久化）。
 * [WHY] 三步引导对首访用户有价值，对回头用户是纯噪音（占 3 屏）。
 * [CONSTRAINT] 读写都包 try/catch：隐私模式下 localStorage 可能抛错，此时退化为「每次都显示」。
 */
const GUIDE_KEY = '__ai_empty_guide_seen'
const type = ['ask', 'question', 'text', 'done'] as const

/** 列表 */
const chatListRef = ref<HTMLElement | null>(null)
// [panel-resize-scroll-v1] TaskProgressPanel 宿主容器：监听其尺寸变化补偿滚动
const panelHostRef = ref<HTMLElement | null>(null)
const atBottom = ref(true)
// [chat-autofollow-v1] 内容 wrapper：观察内容高度变化，贴底时自动跟随（见 template 内注释）
const chatInnerRef = ref<HTMLElement | null>(null)
const guideSeen = ref(readGuideSeen())

const { toast } = useToast()
const { events: busEvents } = useEventBus()
// [runtime-kind-ssot-v1] 阶段条判据读单一真相源：waiting / feedback
const { state: runtimeState } = useRuntime()
// [phase-clock-v1] 阶段文案与秒表来自 useAiPhaseClock（模块级单例），
//   本组件不再自持计时器；「AI 思考中」由此上屏。
const { waitText, waitElapsed } = useAiPhaseClock()

const runtimeKind = computed(() => String(runtimeState.value.kind))
/** [event-archive-v1] 时间线里是否存在刷新前归档的事件（stale:true） */
const hasStaleEvents = computed(() => busEvents.value.some(e => (e.payload as Record<string, unknown> | undefined)?.stale === true))
const timelineItems = computed(() => {
  const out: Array<ScriptItem | TextItem | DoneItem | AskItem | QuestionItem> = []
  for (const ev of busEvents.value) {
    // [ask-card-v1] AI 提问卡：ASK 解析结果，渲染为对话流内可点选/可打字的卡片（替代旧弹窗）
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
      const raw = String(tp.text || '').trim()
      if (!raw) continue
      // [strip-script-blocks-v1] 剥离误分类进 plain 的脚本围栏块；剥完为空则整卡跳过（纯脚本噪音）
      const text = stripScriptBlocks(raw)
      if (!text) continue
      const pv = clampTextPreview(text, TEXT_PREVIEW.lines, TEXT_PREVIEW.chars)
      out.push({ type: 'text', key: `text-${ev.id}`, timeLabel: hmsLabel(ev.ts), text, ...pv })
      continue
    }
    // [turn-block-frame-v1] 块帧建卡：say / handoff / ask 一律委托 buildOneCard（与 timeline-build 同源）。
    // [WHY] 本组件此前只内联处理 ai:question / ai:ask / ai:done / ai:plain / run:start，
    //   `ai:block` 落到下方 `!== 'run:start'` 被静默丢弃 —— 用户实见「say 的内容没有被使用」。
    // [CONSTRAINT] 只借块分支：文本/脚本两类仍走内联逻辑，因其额外做了 stripScriptBlocks 与 denoiseLog，
    //   一并替换会退回那两个噪声问题。script 块由 buildOneCard 返 null（真卡由 run:start 建）。
    if (ev.kind === 'ai:block') {
      const blockCard = buildOneCard(ev)
      if (blockCard) out.push(blockCard)
      continue
    }
    if (ev.kind !== 'run:start') continue
    const p = (ev.payload || {}) as Record<string, unknown>
    const desc = String(p.desc || '').trim()
    const why = String(p.why || '').trim()
    // [script-card-reason-v1] 失败原因（仅 useRunner 的 error 分支下发）
    const reason = String(p.reason || '').trim()
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
    // [log-unfold-v1] 先展开 JSON 转义串（字面量 \n / \u001b）再降噪：
    //   被 stringify 过的输出此前行数恒为 1 且转义码原样上屏（vue-tsc 60 行实测）
    const outTail = tailTextPreview(denoiseLog(unfoldEscapedLog(String(p.stdoutTail || ''))), TAIL_KEEP_LINES, TAIL_MAX_CHARS)
    const errTail = tailTextPreview(denoiseLog(unfoldEscapedLog(String(p.stderrTail || ''))), TAIL_KEEP_LINES, TAIL_MAX_CHARS)
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
      // [card-duration-v1] 终态耗时（useRunner.wrappedEmitStep 注入）
      durationMs: typeof p.durationMs === 'number' ? p.durationMs : null,
      changeCount: Number(p.changeCount || 0),
      stdoutText: outTail.text,
      stdoutHidden: outTail.hiddenLines,
      stderrText: errTail.text,
      stderrHidden: errTail.hiddenLines,
      why,
      reason,
      // [script-card-changes-v1] 本次执行变更文件
      changes: Array.isArray(p.changes) ? (p.changes as Array<{ path: string, type: string }>) : [],
    })
  }

  return stabilizeCardRefs(out)
})
/**
 * 最近一张 script 卡片的 key：只有它接 liveStdout（完整输出），历史卡片用自身 stdoutText 快照
 * [WHY] 不得以 props.running 为闸门 —— useRunner 只在**下一轮** run() 开头清空 liveStdout，
 *   跑到终态后 liveStdout 仍持本轮全量输出；若以 running 判定，卡片一进 done 就退回尾部快照，
 *   用户跑完瞬间「完整输出面板」缩水成 TAIL 若干行，等于把已有能力丢掉。
 * [CONSTRAINT] 仍只投喂「最后一张」script 卡 —— 保留旧实现的正确内核（防同一轮的全局输出串到历史卡片）
 */
const latestScriptKey = computed(() => {
  for (let i = timelineItems.value.length - 1; i >= 0; i--) {
    const it = timelineItems.value[i]
    if (it.type === 'script') return it.key
  }
  return ''
})

watch(
  () => [props.doneSummary, timelineItems.value.length] as const,
  async ([v]) => {
    if (!v && timelineItems.value.length === 0) return
    await nextTick()
    // [done-scroll-bottom-v1] 总结到达时强制滚底：
    // [WHY] 原走 scrollToBottomIfAtBottom（受 atBottom 门控）；用户上翻一次即 atBottom=false，
    //   总结卡落在下方却看不到，与「总结 = 本轮终点」的预期冲突。
    // [CONSTRAINT] 仅当 doneSummary 非空（有新总结）才强制；新一轮清空不滚，避免抖动。
    if (v) forceScrollToBottom()
    else scrollToBottomIfAtBottom()
  },
)
watch(
  () => timelineItems.value,
  (items) => {
    let latest: AnyCard | null = null
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].type === 'script') { latest = items[i]; break }
    }
    if (!latest) return
    if (_seenScriptKeys.has(latest.key)) return
    _seenScriptKeys.add(latest.key)
    void nextTick(forceScrollToBottom)
  },
  { flush: 'post' },
)
/** 引导展示过一次即落记忆位（watch 而非 onMounted：首帧可能还在 running 态） */
watch(() => !guideSeen.value && timelineItems.value.length === 0, (shouldShow) => {
  if (!shouldShow || guideSeen.value) return
  try { window.localStorage.setItem(GUIDE_KEY, '1') } catch { /* ignore */ }
})

// 页面刷新时自动滚到最后一条：
// [WHY] 上面的 watch 非 immediate，刷新时 busEvents 若同步恢复则不触发；需挂载后主动滚一次
// [CONSTRAINT] 仅一次 nextTick 后滚底 —— 不再 rAF 三帧兜底（见上方 [scroll-snap-v2]）
// [CHANGE-IMPACT] 与上面的 watch 互补：watch 管运行时新增，onMounted 管首次挂载
onMounted(async () => {
  await nextTick()
  scrollToBottomIfAtBottom()
  // [panel-resize-scroll-v1] D4：挂 ResizeObserver 观察面板高度变化
  // [CONSTRAINT] 只在浏览器有 ResizeObserver 时挂（SSR/老环境降级为不补偿）
  if (typeof ResizeObserver !== 'undefined' && panelHostRef.value) {
    _lastPanelHeight = panelHostRef.value.getBoundingClientRect().height
    _panelRo = new ResizeObserver(onPanelResize)
    _panelRo.observe(panelHostRef.value)
  }
  // [chat-autofollow-v1] 观察内容 wrapper 高度：任何内容增高（phase 更新 / 折叠区渲染 /
  //   文本卡到达 / 字体加载）在贴底态都自动跟随；用户上翻（atBottom=false）不拽回。
  //   [WHY] watch(timelineItems) 只认「新 script 卡 key」，覆盖不了同卡长高与文本卡到达。
  //   [CONSTRAINT] 回调只做贴底赋值，不改 atBottom（@scroll→updateAtBottom 独占该职责）⇒ 无反馈环。
  if (typeof ResizeObserver !== 'undefined' && chatInnerRef.value) {
    _innerRo = new ResizeObserver(() => scrollToBottomIfAtBottom())
    _innerRo.observe(chatInnerRef.value)
  }
})
onBeforeUnmount(() => { if (_copiedTimer) clearTimeout(_copiedTimer) })
onBeforeUnmount(() => {
  // [panel-resize-scroll-v1] 卸载时断开 ResizeObserver，防内存泄漏
  if (_panelRo) { _panelRo.disconnect(); _panelRo = null }
  if (_innerRo) { _innerRo.disconnect(); _innerRo = null }
})

/**
 * [terminal-actions-v1] 复制当前终端内容。
 * [WHY] 终端输出分散在三处：本轮实时 stdout/stderr（props）与最终 doneSummary（Markdown）。
 * 只复制「用户当前看得到的部分」，按 stdout → stderr → 总结的顺序拼，空段自动跳过。
 * [CONSTRAINT] 优先用 navigator.clipboard；非安全上下文（http 非 localhost）下回退 textarea + execCommand，
 * 否则按钮点了没有任何反应且不报错——比不提供更糟。
 */
async function copyContent(): Promise<void> {
  const parts: string[] = []
  if (props.liveStdout) parts.push(props.liveStdout.trimEnd())
  if (props.liveStderr) parts.push(props.liveStderr.trimEnd())
  const text = parts.filter(Boolean).join('\n')
  if (!text) { toast('当前没有可复制的内容', 'info', TOAST_SHORT); return }
  let ok = false
  try {
    await navigator.clipboard.writeText(text)
    ok = true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      ok = document.execCommand('copy')
      document.body.removeChild(ta)
    } catch { ok = false }
  }
  if (!ok) { toast('复制失败，请手动选择文本复制', 'error', TOAST_MEDIUM) }
}
/**
 * [terminal-actions-v1] 关闭进程：仅在 running 时可用，向父级冒泡 stop。
 * [CONSTRAINT] 不做二次确认——停止是可恢复操作（用户可重新发送指令），
 * 加确认弹窗会让「想立刻停下」的场景多一次点击。
 */
function closeProcess(): void {
  if (!props.running) return
  emit('stop')
  toast('已请求停止当前执行', 'info', TOAST_SHORT)
}
/**
 * [terminal-actions-v1] 终端快捷键：Esc 关闭运行中进程 / Ctrl(⌘)+Shift+C 复制内容。
 * [CONSTRAINT] 只在终端区域聚焦时生效（@keydown 绑在 section 上），不抢全局快捷键；
 * 输入框内按 Esc 时不拦截——那里 Esc 的语义是取消输入。
 */
function onTerminalKeydown(e: KeyboardEvent): void {
  const target = e.target as HTMLElement | null
  const inField = !!target && (/^(?:INPUT|TEXTAREA)$/.test(target.tagName) || target.isContentEditable)
  if (e.key === 'Escape' && !inField) {
    if (props.running) { e.preventDefault(); closeProcess() }
    return
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
    e.preventDefault()
    void copyContent()
  }
}
// [ui-p2c-stable-ref-fix-v1] 判别联合转 Record 需走 unknown 两步（TS2352）
function asRecord(card: AnyCard): Record<string, unknown> {
  return card as unknown as Record<string, unknown>
}
function shallowCardEqual(a: AnyCard, b: AnyCard): boolean {
  const ra = asRecord(a)
  const rb = asRecord(b)
  const ka = Object.keys(ra)
  const kb = Object.keys(rb)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    const va = ra[k]
    const vb = rb[k]
    if (va === vb) continue
    if (Array.isArray(va) && Array.isArray(vb) && JSON.stringify(va) === JSON.stringify(vb)) continue
    return false
  }
  return true
}
function stabilizeCardRefs(cards: AnyCard[]): AnyCard[] {
  const seen = new Set<string>()
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i]
    const prev = _cardCache.get(card.key)
    if (prev && shallowCardEqual(prev, card)) cards[i] = prev
    else _cardCache.set(card.key, card)
    seen.add(card.key)
  }
  for (const k of [..._cardCache.keys()]) { if (!seen.has(k)) _cardCache.delete(k)
  }
  return cards
}
function updateAtBottom(): void {
  const el = chatListRef.value
  if (!el) return
  const cur = el.scrollTop
  const distance = el.scrollHeight - cur - el.clientHeight
  if (cur < lastScrollTop - 1) atBottom.value = false
  else if (distance <= BOTTOM_THRESHOLD_PX) atBottom.value = true
  lastScrollTop = cur
}
function scrollToBottomIfAtBottom(): void {
  if (!atBottom.value) return
  const el = chatListRef.value
  if (el) el.scrollTop = el.scrollHeight
}
// [force-scroll-on-script-start-v1] 脚本开始运行强制可视
// [WHY] scroll-snap-v3 下用户任何上翻即 atBottom=false；新脚本开跑时卡片落在下方，
//   用户完全看不到本轮进展。run:start 是「新脚本开始」的锚点事件。
// [CONSTRAINT] 判据是 updateKey 首次出现（一轮一个）；同轮 phase 更新复用同 key 不触发——
//   否则 running 每 250ms 一次节流会把用户上翻持续拽回，破坏「用户上翻解除吸附」语义。
// [CHANGE-IMPACT] 只认 type==='script' 的新卡；文本 / ask 卡不触发，保持其原有吸附语义。
function forceScrollToBottom(): void {
  const el = chatListRef.value
  if (!el) return
  el.scrollTop = el.scrollHeight
  lastScrollTop = el.scrollTop
  atBottom.value = true
}
function onPanelResize(): void {
  // [panel-overlay-v1] 面板已改浮层（绝对定位），不再侵占 chat-list 空间 ⇒
  //   原高度补偿逻辑失去意义，整体停用（保留 ResizeObserver 挂钩以便回退）。
}
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
function readGuideSeen(): boolean {
  try { return window.localStorage.getItem(GUIDE_KEY) === '1' } catch { return false }
}
/** 用户主动点「看引导」：重新展开并清除记忆位 */
function reopenGuide(): void {
  guideSeen.value = false
  try { window.localStorage.removeItem(GUIDE_KEY) } catch { /* 存储不可用：仅本次生效 */ }
}
</script>

<template>
  <section class="terminal" tabindex="0" @keydown="onTerminalKeydown">
    <!-- [flow-timeline] 全流程时间线 -->
    <div class="flow-timeline">
      <!-- [task-progress-panel-v1] 任务完成详情：待办 + 已完成划线，替代原「已完成 N/M 步」 -->
      <!-- [panel-resize-scroll-v1] 容器 ref 供 ResizeObserver 观察 -->
      <div ref="panelHostRef" class="panel-host">
        <TaskProgressPanel />
      </div>
      <div ref="chatListRef" class="chat-list" @scroll="updateAtBottom">
        <!-- [chat-autofollow-v1] 内容 wrapper：ResizeObserver 观察其高度变化，贴底时自动跟随滚动。
             [WHY] 原 watch 只认「新 script 卡 key」：同卡 phase 更新（running→done）、输出折叠区渲染、
             文本卡到达等都会让内容长高但无人滚动 ⇒ 最新一条被顶出视野（用户实测截图）。
             [CONSTRAINT] 只在 atBottom（贴底/未上翻）时跟随，用户上翻查看历史不被拽回。 -->
        <div ref="chatInnerRef" class="chat-list-inner">
          <!-- [event-archive-v1] 刷新归档提示：时间线保留但对应窗口已关，不可续跑 -->
          <div v-if="hasStaleEvents" class="archive-notice">
            以下为刷新前的历史记录（对应窗口已关闭，无法继续执行）
          </div>
          <!-- 每轮脚本 desc：Markdown 渲染；来源 busEvents（已持久化到 localStorage） -->
          <template v-for="card, n in timelineItems" :key="card.key">
            <ScriptCard
              v-if="card.type === 'script'"
              :key="card.key"
              :card="card"
              :live-stdout="card.key === latestScriptKey ? liveStdout : ''"
              @preview="(p) => emit('preview', p)"
            />
            <RoundCard
              v-else-if="type.includes(card.type) && (card.text || card.preview || '').trim()"
              :key="card.key || n"
              :card="card"
            />
          </template>

          <!-- 空态：无卡片 / 无输出 / 无总结 -->
          <div v-if="!running && !liveStdout && !liveStderr && timelineItems.length === 0" class="tree-empty">
            <!-- [ui-empty-guide-v2] 引导记忆化：首访展示完整三步，之后只留一行。
                 [WHY] 三步引导占 3 屏，对第二次打开的用户是纯噪音；但新用户第一次确实需要。
                 [CONSTRAINT] 记忆位是 localStorage，与「清空会话」解耦——清空历史不该重放引导。 -->
            <template v-if="!guideSeen">
              <div class="empty-title">
                还没有执行记录
              </div>
              <div class="empty-steps">
                <div class="empty-step">
                  <span class="empty-step-n" aria-hidden="true">1</span>
                  <div class="empty-step-body">
                    <div class="empty-step-t">
                      写脚本
                    </div>
                    <div class="empty-step-d">
                      在下方编辑器粘贴或让 AI 生成 cjs / bash 脚本
                    </div>
                  </div>
                </div>
                <div class="empty-step">
                  <span class="empty-step-n" aria-hidden="true">2</span>
                  <div class="empty-step-body">
                    <div class="empty-step-t">
                      点运行
                    </div>
                    <div class="empty-step-d">
                      执行结果与文件改动会出现在这条时间线里
                    </div>
                  </div>
                </div>
                <div class="empty-step">
                  <span class="empty-step-n" aria-hidden="true">3</span>
                  <div class="empty-step-body">
                    <div class="empty-step-t">
                      审变更
                    </div>
                    <div class="empty-step-d">
                      右侧面板看 diff，可回滚；或开启自动循环让 AI 连续跑
                    </div>
                  </div>
                </div>
              </div>
            </template>
            <template v-else>
              <div class="empty-title">
                还没有执行记录
              </div>
              <button type="button" class="empty-guide-reopen" @click="reopenGuide">
                看引导
              </button>
            </template>
          </div>
        </div>
      </div>
      <!-- [status-bar-reserve-v4] 阶段条改为「常驻槽位」：v3 的 absolute 浮层贴底时会盖住正好滚到该高度的
           消息正文（用户截图反馈「不要遮挡下面」）。槽位恒在 flow 中且高度恒定 ⇒ 既保留 v3 的「出现/消失
           不撑动 DOM、新消息到达不上下晃」，又保证正文物理上不与该带重叠。
           waiting=「AI 思考中 / AI 仍在处理」、feedback=「回传中」（文案与秒表来自 useAiPhaseClock）。
           成功/失败、轮数、token 估算已整体移除。 -->
      <div class="status-slot">
        <div
          v-if="runtimeKind === 'waiting' || runtimeKind === 'feedback'"
          class="status-bar-inline"
          :class="`kind-${runtimeKind}`"
          aria-live="polite"
        >
          <span class="status-dot" aria-hidden="true" />
          <span class="status-text">{{ waitText }}</span>
          <span v-if="waitElapsed > 0" class="status-sep">·</span>
          <span v-if="waitElapsed > 0" class="status-elapsed">{{ waitElapsed }}s</span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss" src="./terminal-pane.scss"></style>
