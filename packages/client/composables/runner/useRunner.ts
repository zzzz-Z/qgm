import { computed, ref, watch } from 'vue'
import { useSessionStorage } from '@vueuse/core'
import { emit } from '../ui/useEventStream'
import type { BaselineDiffResponse, Change, ChangeEntry, DecisionPayload, RunResponse } from '../../types'
import { uid } from '../../utils/id'
// [restore-import-v1] readNdjson 早前被按 auto-import 名单清理时误删：app 侧兜底可跑，
// 但 tsc --noEmit 报 Cannot find name 'readNdjson'（run 的 NDJSON 流解析依赖它）
import { readNdjson } from '../../utils/stream'
// [restore-import-v1] log 早前按 auto-import 名单清理时误删（app 侧兜底可跑，但 tsc --noEmit / vitest 无该插件）
import { log } from '../../utils/log'
// [tasks-api-sid-v1] 沙箱 __AI__.tasks 分桶需会话 id；显式 import 便于 vitest 裸跑
import { effectiveSessionId } from '../ui/useAppStorage'
// [multi-workspace-v1] /run 携带目标工作区 id；缺省由服务端用活跃工作区
import { useWorkspaces } from '../data/useWorkspaces'

/** sessionStorage 键：脚本内容 */
const STORAGE_KEY_SCRIPT = '__ai_runner_script'
/** sessionStorage 键：最近一次运行结果 */
const STORAGE_KEY_RESULT = '__ai_runner_result'
/** sessionStorage 键：变更列表 */
const STORAGE_KEY_CHANGES = '__ai_runner_changes'
/** sessionStorage 键：冒烟开关 */
const STORAGE_KEY_SMOKE = '__ai_runner_smoke'
/** sessionStorage 键：基线 runId */
const STORAGE_KEY_BASELINE = '__ai_runner_baseline'
/** sessionStorage 键：会话累积基准 runId */
const STORAGE_KEY_SESSION_BASELINE = '__ai_runner_session_baseline'
/** sessionStorage 键：变更视图（本轮 / 累积） */
const STORAGE_KEY_CHANGE_VIEW = '__ai_runner_change_view'
/** 运行中止控制器；非响应式模块单例，与 stop() 成对管理 */
let abortController: AbortController | null = null
let activeRunToken = 0

// 模块级单例状态 —— 与 useSessionManager 惯例一致
// 每次 useRunner() 返回同一份引用，避免 useAutoLoop 与 ScriptPanel 拿到两份不同的状态
// 持久化统一走 vueuse useSessionStorage：自动 JSON 序列化 + 跨标签页同步
/** 持久化失败提示（仅脚本内容超配额时置位）；由下方 script 的 watch 写入 / 清空 */
const persistWarning = ref('')
/** 脚本内容；[CONSTRAINT] 保留 ref + watch 而非 useSessionStorage：需捕获 QuotaExceeded 设 persistWarning（vueuse 无 onSuccess 回调无法自动清空） */
const script = ref('')
try {
  const raw = sessionStorage.getItem(STORAGE_KEY_SCRIPT)
  if (raw) script.value = JSON.parse(raw) as string
} catch { /* 首次访问或解析失败：保持空脚本 */ }
// [last-run-code] 保存最近一次运行的脚本，script.value 被清空后仍可追溯
/** 最近一次实际执行的脚本源码；内存态，不持久化 */
const lastRunCode = ref('')
/** 是否有运行中的脚本 */
const running = ref(false)
/** 最近一次运行结果；[CONSTRAINT] 值置 null 时 useSessionStorage 会自动移除存储项 */
const result = useSessionStorage<RunResponse | null>(STORAGE_KEY_RESULT, null)
// [selfcheck-observed-cmds-v1] 本轮循环所有 runId 累积（供 DONE 时自检读 toolLog 对账）
export const runIds = ref<string[]>([])
// [stdout-lag-attrib-v1] 跨轮滞后归因（WO-20261007-03 段五）：每次发送时刻按序累积。
// [WHY] summary 帧带 runId（前缀 = 服务端执行开始时刻，见 run.ts 生成式 <ts>-<rand>）。
// [CONSTRAINT] 依赖宿主与 5175 同机（Date.now 同源）；跨机部署改用 runId 到达序配对（退化路径）。
export const sendTimestamps = ref<number[]>([])
/**
 * 按 path 去重：同一文件只保留一条（后到的覆盖先到的）
 * [WHY] 变更列表按 path 唯一才与「撤回单文件」一一对应；三处调用点（初值 / summary 帧 / 累积）
 *   必须同构，否则同一份数据会因入口不同而条数不一致
 */
function dedupByPath<T extends { path: string }>(list: T[]): T[] {
  return list.reduce<T[]>((acc, c) => {
    const i = acc.findIndex(x => x.path === c.path)
    if (i >= 0) acc[i] = c
    else acc.push(c)
    return acc
  }, [])
}

/**
 * [round-changes-runid-v1] 把服务端响应上的归属 runId 盖到每个**缺少** runId 的条目上。
 * [WHY] `/__ai/run-changes` 的 manifest 条目只有 path/type；而变更预览要取「该轮运行前快照」
 *   （POST /__ai/files/before 认 runId）才能算出 +/− 行。不盖 ⇒ 刷新后由兜底恢复出的本轮列表
 *   每条都缺 runId，预览只会显示「未找到变更前快照」，diff 恒空——看着像服务端没落盘，其实是客户端丢字段。
 * [CONSTRAINT] 条目自带 runId 时不覆盖（累积口径由 withOwner 提供归属轮，比本轮更精确）；
 *   runId 缺省时原样返回（宁可缺，也不用错的轮去猜该轮的快照内容）。
 */
function stampRoundRunId(list: ChangeEntry[], runId?: string): ChangeEntry[] {
  return list.map(c => (c.runId ? c : { ...c, runId }))
}

// DEDUP_LAST_RUN: 按 path 去重，只保留最近一次每文件的变更记录
/** 变更列表（**本轮增量**）；初始化后立即 dedup 一次，兼容老版本 sessionStorage 残留 */
const changes = useSessionStorage<ChangeEntry[]>(STORAGE_KEY_CHANGES, [])
changes.value = dedupByPath(changes.value)
/** 单文件回滚进行中标志（键 = 文件路径） */
const rolling = ref<Record<string, boolean>>({})
/** 全局忙状态（rollbackAll / save 进行中） */
const busyAll = ref(false)
/** 实时 stdout 缓冲区（流式累积，刷新会清空） */
const liveStdout = ref('')

/** [done-summary-channel-v1] DONE 后的总结：独立通道，不混入 raw stdout */
export const doneSummary = ref('')

/** 实时 stderr 缓冲区（流式累积，刷新会清空） */
const liveStderr = ref('')

// ── [bg-stream-v1] 后台长任务日志的流式显示 ──
// [WHY] `shell(cmd,{background:true})` 是**即发即返**的：脚本本轮立刻结束，而任务还在后台跑，
//   其输出被重定向到 .ai-runner/tmp/<id>.log，**不经过 /run 的 chunk 帧**；发出任务的那一轮
//   /run 一结束，推送通道随之关闭 ⇒ 跨轮没有任何服务端推流路径，前端此刻一片空白。
//   补齐办法：startBackground 会向 stdout 打一行 `BG_ID=<id>`（走前台 chunk，实时上屏），
//   前端拿到 id 后自行按字节偏移轮询 /__ai/shell-log ⇒ 秒级流式、**不占 AI 轮次、不受 180s 限制**。
/** 后台任务累积输出（按 id 分桶；跨轮保留，避免新一轮清空把长任务进度抹掉） */
const bgLogs = ref<Record<string, string>>({})
/** 正在轮询的后台任务；from = 下次请求要带的字节偏移 */
const bgWatchers = new Map<string, { from: number, timer: ReturnType<typeof setTimeout> | null, done: boolean, fails: number }>()
/** 已收口的后台任务（收口后不再向新一轮注入其输出） */
const bgDone = new Set<string>()
/** 未以换行收尾的残留文本（chunk 可能把 `BG_ID=sh-x` 与它的换行切开） */
let bgCarry = ''
/** 后台日志轮询间隔 */
const BG_POLL_MS = 1000

/**
 * 从一段新增 stdout 中识别完整行的 BG_ID 标记
 * [CONSTRAINT] 只处理「已以换行收尾」的部分，残留留在 bgCarry 等下一块拼接；
 *   残留无上限会让长输出白占内存 ⇒ 超 4KB 仅保留尾部 1KB（标记行远短于此）
 */
function scanBgIds(chunkText: string): string[] {
  const buf = bgCarry + chunkText
  const idx = buf.lastIndexOf('\n')
  if (idx < 0) {
    bgCarry = buf.length > 4096 ? buf.slice(-1024) : buf
    return []
  }
  const complete = buf.slice(0, idx + 1)
  bgCarry = buf.slice(idx + 1)
  const ids: string[] = []
  const re = /(?:^|\n)BG_ID=(sh-[\w-]+)/g
  let m = re.exec(complete)
  while (m !== null) { ids.push(m[1]); m = re.exec(complete) }
  return ids
}

/**
 * 拉一次增量并追加进 liveStdout；返回 true 表示任务已收口（可停止轮询）
 * [CONSTRAINT] 网络失败返回 false 继续重试（任务可能只是还没产出，不能因一次失败就放弃显示）
 */
async function pollBgOnce(id: string): Promise<boolean> {
  const w = bgWatchers.get(id)
  if (!w) return true
  let data: { ok?: boolean, text?: string, next?: number, done?: boolean } = {}
  try {
    const res = await fetch(`/__ai/shell-log?id=${encodeURIComponent(id)}&from=${w.from}`)
    if (!res.ok) { w.fails += 1; return false }
    data = (await res.json()) as typeof data
  } catch {
    w.fails += 1
    return false
  }
  if (!data.ok) { w.fails += 1; return false }
  w.fails = 0
  const text = String(data.text || '')
  w.from = Number(data.next) || w.from
  if (text) {
    bgLogs.value = { ...bgLogs.value, [id]: (bgLogs.value[id] || '') + text }
    liveStdout.value += text
  }
  return data.done === true
}

/** 起一个后台任务的轮询（同 id 幂等）；收口或停止后自行退出循环 */
function startBgWatch(id: string): void {
  if (bgWatchers.has(id) || bgDone.has(id)) return
  const w = { from: 0, timer: null as ReturnType<typeof setTimeout> | null, done: false, fails: 0 }
  bgWatchers.set(id, w)
  const tick = async () => {
    if (!bgWatchers.has(id)) return
    const done = await pollBgOnce(id)
    // [bg-stream-v1] 连续失败上限：任务被清理 / 服务不可达时不再无限重试（否则留一个永不退出的定时器）
    if (done || !bgWatchers.has(id) || w.fails >= 10) {
      bgWatchers.delete(id)
      bgDone.add(id)
      return
    }
    w.timer = setTimeout(() => { void tick() }, BG_POLL_MS)
  }
  void tick()
}

/** 停止全部后台轮询（用户中止运行时调用；后台任务本身不受影响，仍会在服务端跑完） */
function stopBgWatchers(): void {
  for (const w of bgWatchers.values()) {
    if (w.timer) clearTimeout(w.timer)
  }
  bgWatchers.clear()
}

/** 冒烟测试开关；持久化到 sessionStorage */
const smokeEnabled = useSessionStorage<boolean>(STORAGE_KEY_SMOKE, true)
/** 基线 runId（用于对比 diff）；持久化到 sessionStorage */
const baselineRunId = useSessionStorage<string>(STORAGE_KEY_BASELINE, '')
/**
 * [cumulative-baseline-v1] 会话累积基准 runId
 * [WHY] 上面那个 baselineRunId 是「上一次成功轮」的滚动基准（供 AI 回填 prompt 用），只能看一轮；
 *   跨轮累积视图要的是「本页会话第一次成功运行」这个锚点。两者语义不同，不能共用一个键。
 * [CONSTRAINT] 确认改动 / 撤回全部会把它清空（那是新的起点）；基准被 GC 后也清空，由下一轮重新锚定
 */
const sessionBaselineRunId = useSessionStorage<string>(STORAGE_KEY_SESSION_BASELINE, '')
/** 变更视图：`round` = 本轮增量，`cumulative` = 自会话基准以来的累积；持久化到 sessionStorage */
// [checkpoint-default-v1] 默认累积视图：本轮增量随每轮 run() 开头清空（见 :387），
//   任务进行中列表会闪空；累积不随 run 清空，进行中始终可见自会话基准以来的改动。
//   存量 sessionStorage 已存 'round' 的会话沿用其选择，只有新会话/清空 storage 才拿到新默认。
const changeView = useSessionStorage<'round' | 'cumulative'>(STORAGE_KEY_CHANGE_VIEW, 'cumulative')
/** 累积变更列表（每条带归属轮）；仅累积视图下展示 */
const cumulativeChanges = ref<ChangeEntry[]>([])
/** 累积列表是否加载中 */
const cumulativeLoading = ref(false)
/** 累积列表加载失败原因（空串 = 无错） */
const cumulativeError = ref('')
/**
 * 当前应展示的变更列表：由 changeView 决定
 * [WHY] 面板、diff 预览、回滚三处必须共用同一份口径——若面板显示累积而回滚按本轮算，
 *   用户点「撤回」会被服务端以「该文件不在本次改动中」拒绝
 */
const visibleChanges = computed<ChangeEntry[]>(() =>
  changeView.value === 'cumulative' ? cumulativeChanges.value : changes.value,
)
// [auto-feedback] 一次性标志：AI 直接返回的脚本执行后无条件回传结果
/** 是否已请求执行后自动回传（一次性，消费后由 clearAutoFeedback 重置） */
const autoFeedbackRequested = ref(false)
/** [git-commit-always-on-v1] git 提交常开：开关已移除，每轮运行后自动存档 */
const gitCommit = ref(true)

// 脚本持久化：仅 script 一项需要手工 watch（见上方注释）；其余键由 useSessionStorage 内部管理
watch(script, (v) => {
  try {
    sessionStorage.setItem(STORAGE_KEY_SCRIPT, JSON.stringify(v))
    persistWarning.value = ''
  } catch (e) {
    persistWarning.value = '脚本内容过大，已无法持久化到会话存储（刷新后会丢失）'
    log.warn('[ai-runner] sessionStorage 写入失败:', e)
  }
})

/** [done-summary-channel-v1] 写入总结（走独立 ref，不追加 stdout） */
export function pushTerminalNotice(text: string, _opts?: { divider?: boolean }): void {
  const raw = String(text || '')
  if (!raw) return
  doneSummary.value = raw
}

/**
 * 中止当前运行
 * [CONSTRAINT] 幂等：无 abortController 时仅清 running
 * [CHANGE-IMPACT] 触发 readNdjson 抛出 AbortError → run 的 catch 走"已取消"分支
 */
function stop() {
  // [stop-finally-contract-v1] 不得递增 activeRunToken：
  //   run() 的 catch/finally 都以 isStale()（myToken !== activeRunToken）决定是否收口。
  //   stop 里 +1 会让进行中的这轮 run 被判 stale ⇒ finally 跳过「兜底 emit 终态 + running=false」
  //   ⇒ 卡片永久停在 running phase（用户实测：点了停止、toast 也出了，但卡片不动）。
  //   [CONSTRAINT] stop 只负责 abort，让 run 自己走 catch(已取消) → finally(收口)。
  //   连续两次 run 的竞争由新 run 的 ++activeRunToken 天然隔离：新 run 起来后旧 run 才变 stale。
  if (abortController) {
    abortController.abort()
    abortController = null
  }
}

/**
 * [cumulative-baseline-v1] 拉取「自会话基准以来」的累积变更
 * [WHY] 服务端 /__ai/diff-from-baseline 已有基线 diff 能力（此前只被 AI 回填 prompt 消费），
 *   mode='before' 才是累积口径：基准取**该轮运行前**的索引，否则基准轮自身的改动会漏掉。
 *   withOwner 让每条带上归属轮 runId，回滚才有地方落。
 * [CONSTRAINT] 失败一律降级为空列表 + 可读原因，绝不抛给调用方（面板不该因累积视图挂掉）；
 *   基准失效（被 GC / 早于该能力）时清空锚点，由下一轮运行重新锚定——自愈而非死循环报错
 */
async function loadCumulative(): Promise<void> {
  const base = sessionBaselineRunId.value
  cumulativeError.value = ''
  if (!base) {
    cumulativeChanges.value = []
    return
  }
  cumulativeLoading.value = true
  try {
    const res = await fetch('/__ai/diff-from-baseline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baselineRunId: base, mode: 'before', withOwner: true }),
    })
    const data = (await res.json().catch(() => null)) as BaselineDiffResponse | null
    if (!data || data.error) {
      const msg = String(data?.error || '累积视图加载失败')
      cumulativeChanges.value = []
      if (/基准记录不存在|运行前索引/.test(msg)) {
        sessionBaselineRunId.value = ''
        cumulativeError.value = '累积基准已失效（已被回收或早于该能力），下一轮运行会自动重新锚定'
      } else {
        cumulativeError.value = msg
      }
      return
    }
    cumulativeChanges.value = dedupByPath(data.changes || [])
  } catch {
    cumulativeChanges.value = []
    cumulativeError.value = '累积视图加载失败（网络异常）'
  } finally {
    cumulativeLoading.value = false
  }
}

/**
 * 切换变更视图；切到累积时按需拉取（本轮视图不需要请求，数据在 summary 帧里）
 * [WHY] 返回 Promise 而非 `void` 触发：调用方（含测试）需要一个可等待的边界，
 *   否则「切了但没加载完」与「切了没加载」在断言上无法区分
 */
/**
 * [round-changes-v1] 本轮视图的权威兜底：从服务端 run manifest 取该轮改动
 * [WHY] 本轮原本只有 summary 帧的 `changes` 一条路 —— 那一帧没被接住（刷新丢帧 / 多标签 /
 *   执行方不是本页 useRunner）时本轮恒为空，而累积走独立磁盘 diff 照常有数据。服务端每轮 manifest
 *   是本就落盘的权威记录，且**不依赖累积基准**，不会把单点故障变双点（故本轮仍是「单轮」语义，
 *   不是累积的子集，与 [cumulative-baseline-v1] 的拆分保持一致）。
 * [CONSTRAINT] 已有数据时不覆盖（避免与 summary 口径打架）；无 runId 时服务端按「最新一轮」返回，
 *   因此即便本页从未执行过也能拿到最近一轮的改动；请求失败/无记录一律静默，绝不阻断主链路。
 */
async function loadRoundChanges(): Promise<void> {
  if (changes.value.length) return // 本轮已有数据：不覆盖、不发请求
  const runId = result.value?.runId || baselineRunId.value
  try {
    const res = await fetch('/__ai/run-changes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: String(runId || '') }),
    })
    const data = (await res.json().catch(() => null)) as { runId?: string, changes?: ChangeEntry[] } | null
    const list: ChangeEntry[] = Array.isArray(data?.changes) ? data!.changes : []
    const stamped = stampRoundRunId(list, data?.runId)
    if (stamped.length) changes.value = dedupByPath(stamped)
  } catch {
    /* 静默降级：兜底失败不影响主链路 */
  }
}

function setChangeView(v: 'round' | 'cumulative'): Promise<void> {
  changeView.value = v
  // [round-changes-v1] 切回本轮时也走一次兜底：本页从未执行过（无 runId）时由服务端按最新一轮返回
  return v === 'cumulative' ? loadCumulative() : loadRoundChanges()
}

/**
 * 清空两套变更视图并重置会话锚点
 * [WHY] 「确认改动」与「撤回全部」都是语义上的**新的起点**：此后累计应从下一轮算起，
 *   否则已确认的改动会一直挂在累积列表里，越积越假
 */
function resetChangeViews(): void {
  changes.value = []
  cumulativeChanges.value = []
  cumulativeError.value = ''
  sessionBaselineRunId.value = ''
}

/**
 * 从脚本源码猜一个可读的一行摘要（脚本头无 @desc 时的兜底）
 * [WHY] 统一回落到「执行脚本」会让时间线上多张卡片完全同形，用户无从判断这是哪一步；
 *   取首个有效代码行至少能表意（例如 `fs.rmSync(tmp, { recursive: true })`）
 * [CONSTRAINT] 跳过空行与注释行（`//` `/*` `*` `#` —— `#` 同时覆盖 shebang）；
 *   一个有效行都找不到时仍回落 '执行脚本'：TerminalPane 依赖该字面量判定并跳过无信息空卡
 * @param code 脚本源码全文
 */
function guessDesc(code: string): string {
  for (const raw of code.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('//') || line.startsWith('/*') || line.startsWith('*') || line.startsWith('#')) continue
    return line.slice(0, 60)
  }
  return '执行脚本'
}

/**
 * 执行一次脚本运行（NDJSON 流式接收 + 结果落状态）
 * [WHY] opts.script 允许临时脚本（AI 回填），否则跑编辑器内容；runKey 便于把同一轮事件聚到一张卡上
 * [CONSTRAINT] 空脚本或已有运行中直接返回；每轮清空 result/changes/liveStdout/liveStderr/doneSummary
 * [CHANGE-IMPACT] 会写 lastRunCode / running / result / changes，UI 状态依赖此路径；异常走 catch 置 error 帧
 * @param opts 选项对象；script 覆盖编辑器内容、runKey 聚合事件、autoFeedback 置位后本轮结束自动回传
 */
async function run(opts?: { script?: string, runKey?: string, autoFeedback?: boolean }): Promise<RunResponse | 'skipped' | null> {
  const code = (opts?.script ?? script.value).trim()
  // [run-skip-identifiable-v1] 被守卫吞掉时返回可辨识标记（R2）；调用方据此判定重试，不读 result
  if (!code || running.value) return 'skipped'
  // [auto-feedback-reset-v1] 每次 run() 开始重置该标志（R3）：杜绝跨轮漂移
  // [WHY] 上一次 autoFeedback 若未被消费（如被 ScriptPanel 分支遗漏），残留会误触发下一轮
  // [CONSTRAINT] 重置在前、置位在后 —— 保证「本轮想要」才算数
  autoFeedbackRequested.value = false
  if (opts?.autoFeedback) autoFeedbackRequested.value = true
  const myToken = ++activeRunToken
  const isStale = () => myToken !== activeRunToken
  lastRunCode.value = code
  running.value = true
  result.value = null
  changes.value = []
  liveStdout.value = ''
  liveStderr.value = ''
  doneSummary.value = '' // [done-summary-channel-v1] 新一轮清空上轮总结
  // [bg-stream-v1] 新一轮的清空**不能**抹掉仍在跑的后台任务进度（它是跨轮的）⇒ 重新注入未完成任务的累积输出
  const pendingBg = Object.keys(bgLogs.value).filter(id => !bgDone.has(id))
  if (pendingBg.length) liveStdout.value = pendingBg.map(id => bgLogs.value[id] || '').join('')

  // [desc-colon-opt-v1] 脚本头契约规定 `// @desc <做什么>`（无冒号）；兼容历史 `@desc:` 写法
  // [WHY] 原正则强制冒号，AI 按脚本头契约输出无冒号时匹配失败 → 卡片永远显示 fallback
  // [CONSTRAINT] 冒号可选：`@desc xxx` 与 `@desc: xxx` 均可；[ \t]* 允许冒号两侧空白
  const metaM = code.match(/^[^\S\n]*(?:\/\/|#)[^\S\n]*@desc[^\S\n]*(?::[^\S\n]*)?(\S[^\n]*)$/m)
  const desc = metaM ? metaM[1].trim().slice(0, 200) : guessDesc(code)
  // [script-card-payload-v1] 提取 @why 与语言，供 TerminalPane 脚本卡片渲染（Markdown 化）
  const whyM = code.match(/^[^\S\n]*(?:\/\/|#)[^\S\n]*@why[^\S\n]*(?::[^\S\n]*)?(\S[^\n]*)$/m)
  const why = whyM ? whyM[1].trim().slice(0, 200) : ''
  const lang = /^#!\s*\/usr\/bin\/env\s+(?:bash|sh)\b/m.test(code) ? 'bash' : 'cjs'
  // [run-uk-unique] 每次运行唯一 key，避免同 key 覆盖历史事件导致位置错乱
  const UK = opts?.runKey || uid('run')
  // [card-duration-v1] 本轮起点：供每张卡片独立显示执行耗时（终态时计算）
  const _runStartTs = Date.now()
  const emitStep = (phase: string, over: Record<string, unknown> = {}) => {
    // [timeline-denoise-v1] summary 只放 desc：原先拼接了原始 stdout 尾行（titleOf），
    //   但 summary 从未被任何组件渲染，却会随每次 250ms 节流更新写进 localStorage ——
    //   既是纯噪音，也让长输出白付一次 JSON 序列化。展示所需信息全部走 payload。
    emit('run:start', desc, {
      payload: { desc, why, lang, phase, stdoutTail: liveStdout.value.slice(-400), stderrTail: liveStderr.value.slice(-400), ...over },
      updateKey: UK,
    })
  }
  let finalPhase: 'running' | 'done' | 'error' = 'running' // [loading-fix]
  const wrappedEmitStep = (phase: string, over: Record<string, unknown> = {}) => {
    if (phase === 'done' || phase === 'error') {
      finalPhase = phase
      // [card-duration-v1] 终态带本轮耗时（run 起点 → 收口），供每张卡片各自显示
      over = { ...over, durationMs: Date.now() - _runStartTs }
    }
    emitStep(phase, over)
  }
  wrappedEmitStep('running')
  let lastFlush = 0
  /** 刷新分块 */
  const flushChunk = () => {
    const now = Date.now()
    if (now - lastFlush < 250) return
    lastFlush = now
    wrappedEmitStep('running')
  }

  try {
    abortController = new AbortController()
    // [stdout-lag-attrib-v1] 记录发送时刻（WO-20261007-03 段五补遗）：summary 帧带 runId，
    //   其前缀即服务端执行开始时刻，零协议改动即可跨轮归因（原「需 NDJSON seq」判断已作废）。
    //   下方 _elapsed < 1 的「异常早到」启发式保留（抓时钟回拨/乱序，属另一类异常）。
    //   [CONSTRAINT] 依赖宿主与 5175 同机（Date.now 同源）；跨机部署改用 runId 到达序配对。
    const _sendTs = Date.now()
    sendTimestamps.value = [...sendTimestamps.value, _sendTs]
    const res = await fetch('/__ai/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        script: code,
        gitCommit: gitCommit.value,
        smoke: smokeEnabled.value,
        sessionId: effectiveSessionId.value || undefined,
        workspaceId: useWorkspaces().activeId.value || undefined,
        sandbox: (() => { try { return localStorage.getItem('__ai_sandbox') || 'read-only' } catch { return 'read-only' } })(),
      }),
      signal: abortController.signal,
    })
    if (!res.ok || !res.body) {
      let detail = ''
      // [truncation-detect-v1] 前置拦截的响应体是 JSON（{error, syntaxError, truncated, scriptSize}）。
      // 原实现只 res.text() 摊平成一坨字符串 → 客户端无从区分「被上游截断」与「AI 写错了」，
      // 于是两者都渲染成「退出码 400」，AI 对截断也走原地重试，必然再次被截断（两轮后熔断）。
      // 结构化提升只做白名单字段，其余一律保持原文，避免把未知结构带进 result。
      const meta: Partial<Pick<RunResponse, 'truncated' | 'scriptSize' | 'breaker'>> = {}
      try {
        const rawText = await res.text()
        detail = rawText
        try {
          const parsed = JSON.parse(rawText) as { truncated?: unknown, scriptSize?: unknown, breaker?: unknown }
          if (parsed.truncated === true) meta.truncated = true
          if (parsed.breaker === true) meta.breaker = true
          const sz = parsed.scriptSize as RunResponse['scriptSize'] | undefined
          if (sz && typeof sz.lines === 'number' && typeof sz.bytes === 'number') meta.scriptSize = sz
        } catch { /* 非 JSON 响应（代理错误页等）：保持原文，不做结构化提升 */ }
      } catch { /* swallow: body 已被消费 / 网络中断，detail 保持空串 */ }
      result.value = {
        runId: '',
        code: res.status,
        ok: false,
        stdout: '',
        stderr: `HTTP ${res.status} ${res.statusText}${detail ? `\n${detail}` : ''}`,
        changes: [],
        error: `请求失败 (HTTP ${res.status})`,
        ...meta,
      }
      return result.value
    }
    const frames: Record<string, unknown>[] = []
    // [P3-2c] summary 帧消费
    let _summaryDecision: DecisionPayload | null = null
    let _summaryNeedFiles: string[] | null = null
    await readNdjson<Record<string, unknown>>(res.body, (frame) => {
      if (isStale()) return
      if (frame.type === 'summary') {
        if (frame.decision && typeof frame.decision === 'object') {
          _summaryDecision = frame.decision as DecisionPayload
        }
        if (Array.isArray(frame.needFiles)) {
          _summaryNeedFiles = frame.needFiles as string[]
        }
        // summary 帧必须 push，否则 frames[last] 拿不到 summary
        frames.push(frame)
      } else if (frame.type === 'chunk') {
        if (frame.stream === 'stdout') {
          const data = String(frame.data || '')
          liveStdout.value += data
          // [bg-stream-v1] 后台任务 id 标记走前台 stdout，随 chunk 实时到达 ⇒ 立刻起轮询
          for (const id of scanBgIds(data)) startBgWatch(id)
        } else if (frame.stream === 'stderr') {
          liveStderr.value += String(frame.data || '')
        }
        flushChunk()
      }
    }, abortController.signal)
    // [frames-tail-fix-v1] 原取 frames 尾帧作为 summary；但 stage 帧也会 push，
    // 若 summary 帧之后还有 stage 帧（服务端顺序不保证），会错把 stage 当 summary，
    // 导致 runId/changes/ok 全部缺失。改为按 type === 'summary' 精确匹配。
    const summary: Record<string, unknown> | null = (() => {
      for (let i = frames.length - 1; i >= 0; i--) {
        if (frames[i].type === 'summary') return frames[i]
      }
      return null
    })()
    if (summary) {
      if (isStale()) return null
      // [stdout-lag-attrib-v1] 回执异常早到告警（段五）：正常需一次网络往返，< 1ms 视为异常。
      const _elapsed = Date.now() - _sendTs
      if (_elapsed < 1) console.warn('[run] 回执早于/等于发送时刻（疑似时钟回拨或乱序信号）', { elapsed: _elapsed, runId: summary.runId })
      // [stdout-lag-attrib-v1] 跨轮滞后归因：execStart（runId 前缀）落在更早的发送轮 ⇒ 本回执是上一轮的。
      const _execStart = Number(String(summary.runId || '').split('-')[0]) || 0
      const _sends = sendTimestamps.value
      if (_execStart > 0 && _sends.length > 0) {
        let _k = -1
        for (let i = _sends.length - 1; i >= 0; i--) { if (_sends[i] <= _execStart) { _k = i; break } }
        const _n = _sends.length - 1
        if (_k >= 0 && _k < _n) console.warn(`[run] 回执滞后归因：本回执属第 ${_k} 轮脚本，当前已是第 ${_n} 轮`, { k: _k, n: _n, execStart: _execStart, sendTs: _sends[_n], runId: summary.runId })
      }
      const s = summary
      const data: RunResponse = {
        runId: String(s.runId || ''),
        code: Number(s.code ?? -1),
        ok: Boolean(s.ok),
        // [run-timeout-visible-v1] 承接超时标记：UI/回执据此把「超时被杀」与「逻辑失败」分开
        timedOut: Boolean(s.timedOut),
        scriptDesc: String(s.scriptDesc || ''),
        scriptWhy: String(s.scriptWhy || ''),
        // 输出以流式 chunk 累积为准；summary 仅带 tail 兜底（刷新/丢帧），notice 附加服务端提示
        stdout: liveStdout.value || String(s.stdoutTail || s.stdout || ''),
        stderr: (liveStderr.value || String(s.stderrTail || s.stderr || '')) + (s.notice ? `\n${String(s.notice)}` : ''),
        changes: (s.changes as Change[]) || [],
        lint: (s.lint as RunResponse['lint']) ?? null,
        test: (s.test as RunResponse['test']) ?? null,
        tsc: (s.tsc as RunResponse['tsc']) ?? null,
        errorFiles: (s.errorFiles as string[]) || undefined,
        scriptCtx: (s.scriptCtx as string) || undefined,
        // [budget-feedback-v1] 正常轮的脚本体积（服务端每轮都下发，成功轮同样有值）：
        //   缺此字段时 AI 只在被截断后才第一次知道体积，无法事前收窄本轮范围。
        scriptSize: (s.scriptSize as RunResponse['scriptSize']) ?? undefined,
        fingerprints: (s.fingerprints as RunResponse['fingerprints']) || undefined,
        git: s.git as RunResponse['git'],
        dryRunFailed: Boolean(s.dryRunFailed),
        dryRunChangeCount: Number(s.dryRunChangeCount ?? 0),
        dryRunReason: s.dryRunReason as string | undefined,
        wantChanges: s.wantChanges as Change[] | undefined,
        tools: s.tools as RunResponse['tools'],
        smoke: (s.smoke as RunResponse['smoke']) ?? null,
        claimMismatch: (s.claimMismatch as RunResponse['claimMismatch']) ?? null,
        // [pipeline-in-summary-v1] 捕获 summary 帧下发的 pipeline，供 /__ai/tasks 消费方读取
        pipeline: (s.pipeline as RunResponse['pipeline']) ?? undefined,
      }
      // [selfcheck-observed-cmds-v1] 累积 runId（供自检读 toolLog）
      if (data.runId && !runIds.value.includes(data.runId)) runIds.value = [...runIds.value, data.runId]
      const prevBaseline = baselineRunId.value
      result.value = data
      // DEDUP_LAST_RUN: 按 path 去重，只保留本次运行每个文件一条记录
      changes.value = dedupByPath(data.changes || [])
      // [cumulative-baseline-v1] 会话累积锚点：只认本页会话第一次**成功**的 run。
      //   失败轮不落盘（overlay 仅在 exit 0 才 apply），故锚到成功轮不会漏改动。
      if (data.ok && data.runId && !sessionBaselineRunId.value) sessionBaselineRunId.value = data.runId
      if (data.ok && data.runId) baselineRunId.value = data.runId
      if (result.value) result.value.baselineRunId = prevBaseline
      // [round-changes-v1] summary 未带回本轮改动时，用服务端 run manifest 兜底 —— 这是「本轮恒空」的根治：
      //   本轮不再只依赖浏览器有没有接住 summary 帧那一单条链路
      if (changes.value.length === 0) await loadRoundChanges()
      // 累积视图打开时每轮结束都要刷新——否则面板停在旧累计上，用户以为改动没生效
      if (changeView.value === 'cumulative') await loadCumulative()
      wrappedEmitStep(data.ok ? 'done' : 'error', { exit: data.code, changeCount: changes.value.length, changes: changes.value.map(c => ({ path: c.path, type: c.type })) })
    } else {
      result.value = {
        runId: '',
        code: -1,
        ok: false,
        stdout: liveStdout.value,
        stderr: liveStderr.value || '未收到 summary 帧',
        changes: [],
        decision: _summaryDecision,
        needFiles: _summaryNeedFiles,
      }
      wrappedEmitStep('error', { reason: '未收到 summary 帧' })
    }
  } catch (e) {
    if (isStale()) return null
    const aborted = (e as { name?: string })?.name === 'AbortError'
    result.value = {
      runId: '',
      code: -1,
      ok: false,
      stdout: liveStdout.value,
      stderr: aborted ? liveStderr.value : `请求异常：${String(e)}`,
      changes: [],
      error: aborted ? '已取消' : `请求异常：${String(e)}`,
    }
    wrappedEmitStep('error', { reason: aborted ? '已取消' : String(e).slice(0, 80) })
  } finally {
    if (!isStale()) {
      // 兜底：任何提前 return（HTTP 错误 / 无 body）都会走到这，确保 emit 结束态
      if (finalPhase === 'running') {
        const ok = result.value?.ok === true
        wrappedEmitStep(ok ? 'done' : 'error', { exit: result.value?.code, changeCount: changes.value.length, changes: changes.value.map(c => ({ path: c.path, type: c.type })), fallback: true })
      }
      running.value = false
    }
  }
  return result.value
}

/**
 * 回滚单个文件到「它所属那一轮」运行前的状态
 * [WHY] [cumulative-baseline-v1] 归属轮由列表条目自带：累积视图里一条变更可能来自好几轮前，
 *   若一律用本轮 runId，/__ai/rollback 会以「该文件不在本次改动中」400 拒绝——
 *   而用户看到的是「列表里有这个文件」，静默失败比报错更糟。本轮视图下条目无 runId，回落本轮。
 * [CONSTRAINT] 无 result.value 时静默 no-op；rolling[file] 置位期间 UI 显示行级 loading
 * [CHANGE-IMPACT] 成功时从两套列表同时移除该文件（否则另一个视图里还留着已还原的文件）
 * @param file 文件相对路径；与 /__ai/rollback 的 file 字段一致
 */
async function rollback(file: string) {
  if (!result.value) return
  const entry = visibleChanges.value.find(c => c.path === file)
  const runId = entry?.runId || result.value.runId
  rolling.value[file] = true
  try {
    const res = await fetch('/__ai/rollback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId, file }),
    })
    // [rollback-catch-v1] res.json() 无 catch 会在网络异常时 unhandled rejection（报告 §2.20）
    const data = await res.json().catch(() => ({ ok: false }))
    if (data.ok) {
      changes.value = changes.value.filter(c => c.path !== file)
      cumulativeChanges.value = cumulativeChanges.value.filter(c => c.path !== file)
    }
    return data
  } finally {
    rolling.value[file] = false
  }
}

/**
 * 执行 rollback All
 * [WHY] [cumulative-baseline-v1] 累积视图下必须逐条按各自归属轮回滚：/__ai/rollback-all 只处理
 *   单个 runId 的 manifest，用它撤累积列表等于「只撤最后一轮」——而按钮写着「撤回全部」，
 *   这种静默漏撤比直接报错更难被发现。
 * [CONSTRAINT] 逐条串行，避免并发写同一工作区；任一条失败不中断其余，最后如实汇报失败条数
 */
async function rollbackAll() {
  if (!result.value) return
  busyAll.value = true
  try {
    if (changeView.value === 'cumulative' && cumulativeChanges.value.length) {
      const paths = cumulativeChanges.value.map(c => c.path)
      let failed = 0
      for (const p of paths) {
        const d = await rollback(p)
        if (!d || !d.ok) failed += 1
      }
      if (failed === 0) {
        resetChangeViews()
        return { ok: true, count: paths.length }
      }
      await loadCumulative()
      return { ok: false, error: `${failed} / ${paths.length} 个文件撤回失败（其余已还原）` }
    }
    const res = await fetch('/__ai/rollback-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: result.value.runId }),
    })
    const data = await res.json().catch(() => ({ ok: false }))
    if (data.ok) resetChangeViews()
    return data
  } finally {
    busyAll.value = false
  }
}

/**
 * 执行 save（确认改动）
 * [NOTE] [cumulative-baseline-v1] 累积视图下本操作只回收**本轮**的运行前 ref；更早各轮的
 *   ref/快照会留到 gcSnapshots(20) 自然回收。用户可见语义（列表清空、起点重置）不受影响。
 */
async function save() {
  if (!result.value) return
  busyAll.value = true
  try {
    await fetch('/__ai/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: result.value.runId }),
    }).catch(() => null)
    resetChangeViews()
  } finally {
    busyAll.value = false
  }
}

/**
 * 组合式函数 Runner
 */
export function useRunner() {
  return {
    script,
    lastRunCode,
    running,
    result,
    // [selfcheck-observed-cmds-v1] 本轮循环已累积 runId 列表
    runIds,
    changes,
    rolling,
    busyAll,
    persistWarning,
    gitCommit,
    smokeEnabled,
    baselineRunId,
    // [cumulative-baseline-v1] 跨轮累积视图
    sessionBaselineRunId,
    changeView,
    cumulativeChanges,
    cumulativeLoading,
    cumulativeError,
    visibleChanges,
    loadCumulative,
    setChangeView,
    liveStdout,
    liveStderr,
    doneSummary,
    // [bg-stream-v1] 后台长任务：bgLogs 按 id 分桶的累积输出；stopBgTracking 停止轮询（任务本身仍在服务端跑）
    bgLogs,
    stopBgTracking: stopBgWatchers,
    pipelineFromServer: () => result.value?.pipeline,
    autoFeedbackRequested,
    clearAutoFeedback: () => { autoFeedbackRequested.value = false },
    run,
    stop,
    rollback,
    rollbackAll,
    save,
  }
}
