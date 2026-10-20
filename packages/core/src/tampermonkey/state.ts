// @ts-nocheck
// [tampermonkey-ts-rewrite-v1] IIFE 物理切分片段，非独立模块；跨片段符号在单文件检查下不可见。
//   全部片段 TS 化完成、按拼回后的联合视图接线后再移除本 pragma。

/**
 * 跨 poll 的模块级状态 —— 去重集合、生成期追踪、触顶/停止旗标。
 * [WHY] 这些变量是「同一轮内多次 classifyAndPost 之间」的记忆：去重靠集合，
 *   中断判定靠「上一轮是否在生成」，触顶靠「本轮是否已报过」。
 *   它们一旦被提前清空，症状都是「同一条内容被推两次」或「半截回复被补发」。
 * [CONSTRAINT] 所有**随轮次失效**的状态必须集中在 resetRoundState() 里，
 *   不得散落到 fill / rotate 各自的分支——实测过漏抄一项就静默漏配。
 */

/** 上一次推送时的正文签名；stopped / limit 分支据此判断「本轮是否已处理过该正文」 */
let lastBodySig = ''

/**
 * [turn-invalid-v1] 已回传过 turn-invalid 的正文签名。
 * [WHY] 违规回传必须去重：正文静止后 800ms 空转轮询每拍都会走到那个分支，
 *   不去重会每 800ms 给工作台推一条一模一样的 TURN_NOT_JSON。
 * [CONSTRAINT] 随轮次失效（新信封到来即应重新具备报警能力），故在 resetRoundState 里清空。
 */
let _invalidReportedSig = ''

/** SCRIPT 标记存在但载荷不是合法代码块时，本轮只报一次错 */
let _scriptFenceReported = false

/**
 * stopped 分支的回传文案。
 * [CONSTRAINT] 必须分段拼接：整句字面量会成为探针源码的自命中
 *   （本文件会被工作台 dump 进会话，停机态文案与 UI 文案同形）。
 */
const STOPPED_GENERIC = 'AI 网页' + '已停止' + '生成'

/** 本轮是否已推过 stopped；置位后 script / plain 分支都不再补发残留内容 */
let stopPosted = false

/** 上一轮 classifyAndPost 看到的生成态；「从有到无」是中断判据的一半 */
let prevGenerating = false

/** 进入生成时的根数量与最后根身份；与当前值比对判定「没产出任何回复块」 */
let genEnterRoots = 0
let genEnterRootId = ''

/** 本轮是否已推过 limit；只压「存量兜底」通道，增长通道自限不 gate */
let limitPosted = false

/** 触顶探针的轮次基线（fill/rotate 时同步为当前存量） */
let limitMarkerBaseline = 0
let limitMarkerText = ''
let assistantRootBaseline = 0

/** 冷启动守卫：首个 fill/rotate 前只记基线、不报「本轮新增」 */
let _roundBaselinesReady = false

/**
 * 三个单飞定时器。
 * [WHY] 它们必须集中声明：observer 与 dispatch 两个片段都要读写，
 *   分散声明会在拼回同一 IIFE 时产生重复 let（@ts-nocheck 拦不住，只有拼回才发现）。
 * [CONSTRAINT] 各自「已挂则不再挂」是单飞语义的来源：无此判断会在回调风暴下堆出大量定时器。
 */
let observerDebounce: ReturnType<typeof setTimeout> | null = null
/** 结构未闭合块被延迟时的单飞复查定时器 */
let closureRetryTimer: ReturnType<typeof setTimeout> | null = null
/** 生成期自巡检单飞定时器：生成结束往往不是 DOM 事件，需要主动唤醒 */
let genRetryTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 开启新一轮（fill / rotate 共用）。
 * [WHY] 这两条分支原本各自抄了同一串重置语句，任何新增状态只要漏抄一处就会静默漏配
 *   （例如漏清 stopPosted ⇒ 新一轮的脚本被上一轮的停止旗标挡死）。
 * [CONSTRAINT] **停止（stop）不走这里**：停止后要保留去重集合与正文签名，
 *   否则旧回复会被重判为新回复重新推送。
 * [CHANGE-IMPACT] 后续新增任何「随轮次失效」的状态，一律加进本函数，不要加在调用方。
 */
/**
 * [generating-state-v1] 生成态变化的唯一出口：值变即推帧。
 * [WHY] 前端 remoteGenerating 依赖它判断「AI 是否还在吐字」——影响停止按钮可见性与超时告警分流。
 * [CONSTRAINT] 必须用包装函数而非裸赋值，否则 4 处赋值点都要各自记得推帧。
 */
function setPrevGenerating(v: boolean): void {
  const next = Boolean(v)
  if (next === prevGenerating) return
  prevGenerating = next
  post({ type: 'ai-runner:generating-state', generating: next, site: location.origin })
}

function resetRoundState(): void {
  stopPosted = false
  // [generating-state-v1] 走统一出口（值变会推帧；复位到 false 时前端能收到）
  setPrevGenerating(false)
  genEnterRoots = 0
  genEnterRootId = ''
  limitPosted = false
  _scriptFenceReported = false
  // [turn-invalid-v1] 新一轮开始 ⇒ 重新具备违规报警能力（上一轮的正文已作废）
  _invalidReportedSig = ''
  _roundBaselinesReady = true
  // 结构闭合门挂在 window 上：上一轮遗留的门会拿旧长度当基线，
  // 让新回复第一帧就被判「已静止」⇒ 未闭合块提前放行
  ;(window as any).__aiRunnerClosureGate = null
  if (genRetryTimer) { clearTimeout(genRetryTimer); genRetryTimer = null }
  syncLimitMarkerBaseline()
  resumeReplyObserver()
}
