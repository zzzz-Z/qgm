<script setup lang="ts">
// PLAN 5.2 第四层：原始输出折叠
// 复用项目已有极简 markdown 渲染器（不引入新依赖）
// 事件流单例（localStorage 持久化），用于渲染每轮脚本 desc
// [rd-import-v1] 引入抽出的轮次分隔条组件
import RoundDivider from './RoundDivider.vue'
import TaskProgressPanel from './TaskProgressPanel.vue'
// [panel-resize-scroll-v1] D4：面板尺寸变化时补偿 chat-list scrollTop，防贴底跳变
// [sc-wire-v1] 脚本卡片抽为子组件
import ScriptCard from './ScriptCard.vue'
// [timeline-denoise-v1] 长文本卡片的展开/收起入口
// [round-card-v1] done / text / ask / question 四类卡片抽为子组件
import RoundCard from './RoundCard.vue'
// [timeline-denoise-v1] 长文本预览 / 原始输出尾部折叠（纯函数，见 utils/timeline-preview.ts）
// [CONSTRAINT] 显式 import 而非依赖 auto-import：vitest 与 tsc 没有 auto-import 插件
import { clampTextPreview, denoiseLog, tailTextPreview } from '../../utils/timeline-preview'
// [strip-script-blocks-v1] 剥离误分类进 plain 的脚本围栏块（消除脚本正文渲染成文本卡的噪音）
import { stripScriptBlocks } from '../../utils/strip-script-blocks'
// [preview-ssot-v1] 预览阈值统一定义在 timeline-build（单一定义，防两处分叉）
import { ASK_PREVIEW, DONE_PREVIEW, TAIL_KEEP_LINES, TAIL_MAX_CHARS, TEXT_PREVIEW } from '../../utils/timeline-build'
// [eventbus-name-clash-v1] 显式 import（原因同 ScriptPanel.vue）
import { useEventBus } from '../../composables/ui/useEventStream'

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
// [round-divider-v1] 轮次分隔条：loopRound 变化时插入，视觉上呈现 TRAE 式「轮次分组」
// [CONSTRAINT] 依赖 payload.loopRound（由 App.vue ...currentLoopContext() 注入）；手动模式无 loopRound → 不插条
interface DividerItem { type: 'round-divider', key: string, roundLabel: string, timeLabel: string }
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
type AnyCard = ScriptItem | TextItem | DoneItem | AskItem | QuestionItem | DividerItem

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
  // [deliver-window-v1] 结果已产出但回传窗未收口（脚本跑完 → 真正发出去之间那几秒）。
  //   此前这段完全不可见：界面显示「成功」却什么都没发生，用户以为卡住或漏发。
  delivering?: boolean
}>()
// [script-card-changes-v1] 冒泡 ScriptCard 的预览点击 → 由 ScriptPanel 打开浮层
const emit = defineEmits<{ preview: [path: string] }>()

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

// 等待时长本地计时：aiWaiting 为 true 时启动，false 时停止并归零
// [WHY] 用本地 interval 而非改 useAiWaiting 契约（避免污染其他消费方）；仅用于展示层
// [CONSTRAINT] useIntervalFn 组件卸载自动清理；watch 双向同步启停
// [CHANGE-IMPACT] 与 wait-banner 模板成对；去掉 watch 会让秒数永远为 0
const waitElapsed = ref(0)
/** 列表 */
const chatListRef = ref<HTMLElement | null>(null)
// [panel-resize-scroll-v1] TaskProgressPanel 宿主容器：监听其尺寸变化补偿滚动
const panelHostRef = ref<HTMLElement | null>(null)
const atBottom = ref(true)
// [chat-autofollow-v1] 内容 wrapper：观察内容高度变化，贴底时自动跟随（见 template 内注释）
const chatInnerRef = ref<HTMLElement | null>(null)

const { events: busEvents } = useEventBus()
const { pause: pauseWaitTimer, resume: resumeWaitTimer } = useIntervalFn(() => {
  waitElapsed.value += 1
}, 1000, { immediate: false })

const timelineItems = computed(() => {
  const out: Array<ScriptItem | TextItem | DoneItem | AskItem | QuestionItem | DividerItem> = []
  // [round-divider-v1] 追踪上一张脚本卡的轮次；跨轮时插入分隔条（初始 0 表示尚未出现任何轮次）
  let lastRound = 0
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
    const outTail = tailTextPreview(denoiseLog(String(p.stdoutTail || '')), TAIL_KEEP_LINES, TAIL_MAX_CHARS)
    const errTail = tailTextPreview(denoiseLog(String(p.stderrTail || '')), TAIL_KEEP_LINES, TAIL_MAX_CHARS)
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

// [deliver-window-v1] delivering 期同样算「等待」——扩展原 loading 时长，不新增文案。
watch(() => props.aiWaiting || Boolean(props.delivering), (v) => {
  if (v) { waitElapsed.value = 0; resumeWaitTimer() }
  else { pauseWaitTimer(); waitElapsed.value = 0 }
}, { immediate: true })
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
onBeforeUnmount(() => {
  // [panel-resize-scroll-v1] 卸载时断开 ResizeObserver，防内存泄漏
  if (_panelRo) { _panelRo.disconnect(); _panelRo = null }
  if (_innerRo) { _innerRo.disconnect(); _innerRo = null }
})

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
</script>

<template>
  <section class="terminal">
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
              :live-stdout="card.key === latestScriptKey ? liveStdout : ''"
              @preview="(p) => emit('preview', p)"
            />
            <RoundCard
              v-else
              :key="card.key"
              :card="card"
            />
          </template>

          <!-- 空态：无卡片 / 无输出 / 无总结 -->
          <div v-if="!running && !liveStdout && !liveStderr && timelineItems.length === 0" class="tree-empty">
            <!-- [ui-empty-guide-v1] 三入口引导（WO-20261007-02 阶段 C1）：
               原为空区一行「还没有执行记录」，新用户无从知道「运行什么、去哪写、循环是什么」。 -->
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
          </div>
        </div>
      </div>
      <!-- 等待 AI 回复指示条：收到首个回复后由 stopAiWaiting 关闭。
           [wait-banner-overlay-v1] 已浮层化（absolute 悬浮于时间线底部安全带内），
           出现/消失不再把 chat-list 压矮 ⇒ 最新一条不再被顶出视野（用户实测截图）。 -->
      <div v-if="props.aiWaiting || props.delivering" class="wait-banner" role="status" aria-live="polite">
        <span class="wait-spinner" aria-hidden="true" />
        <span class="wait-text">{{ waitElapsed >= 30 ? 'AI 仍在处理' : 'AI 思考中' }}</span>
        <span class="wait-dots" aria-hidden="true" />
        <span v-if="waitElapsed > 0" class="wait-elapsed" aria-hidden="true">{{ waitElapsed }}s</span>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss" src="./terminal-pane.scss"></style>
