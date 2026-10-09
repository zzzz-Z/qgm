// [board-mirror-v1] 把「宿主侧任务看板」的三条纪律抄进应用端每轮回传：
//   ① 状态常驻上下文：每轮回传都把当前未完成任务（**带 id**）递到 AI 面前，
//      而不是指望它翻 SYSTEM.md 自觉记账（2026-10-08 实测：21 个脚本全部成功、看板 0/7 一动不动）；
//   ② 单点直传：要求用 id 调 start/complete/fail —— 三级模糊匹配会「complete 未命中」哑火；
//   ③ 失败态显式化：做不成必须 fail([id]) 收尾，不许沉默挂待办。
// [WHY] 看板状态机（task-store.applyTaskMutation）只在收到显式 start/complete/fail 请求时改状态，
//   与脚本执行**零联动**；本模块是「让 AI 不得不看见并照做」的最轻手段（不改状态机、不改匹配语义）。
// [CONSTRAINT] 抓取失败 / 无未完成任务 ⇒ 返回空串，绝不阻断回传（与 lessons 注入同一纪律）。
// [CONSTRAINT] 显式 import（vitest 无 auto-import 插件，见 AGENTS.md 项目独有约束）
import { effectiveSessionId } from '../ui/useAppStorage.js'

/** 看板条目（服务端 items 的线上形状；外部数据不可信，逐字段清洗） */
export interface BoardMirrorItem { id?: string, desc?: string, status?: string }

/** [board-mirror-stale-v1] 连续多少轮「未完成集合指纹不变」才升级为警告（首轮不警告） */
export const BOARD_STALE_ROUNDS = 3

const NL = String.fromCharCode(10)

/** 清洗为可用条目：只要 pending / running，desc 为空即丢弃 */
function openItems(items: BoardMirrorItem[]): Array<{ id: string, desc: string, status: 'pending' | 'running' }> {
  const src = Array.isArray(items) ? items : []
  const out: Array<{ id: string, desc: string, status: 'pending' | 'running' }> = []
  for (const raw of src) {
    if (!raw || typeof raw !== 'object') continue
    const desc = String(raw.desc || '').trim()
    if (!desc) continue
    const st = String(raw.status || 'pending')
    // [CONSTRAINT] 只渲染未完成（pending / running）；done / failed 与未知态一律不进清单，
    //   否则「已完成项」会被当成待办反复递给 AI（实测：done 项因缺该过滤被算进未完成计数）
    if (st !== 'pending' && st !== 'running') continue
    out.push({ id: String(raw.id || '').trim(), desc, status: st === 'running' ? 'running' : 'pending' })
  }
  return out
}

/**
 * 纯格式化：把未完成任务清单渲染成回传 prompt 的一个块
 * @param items 服务端 items（含 done / failed，用于「已完成 N」计数）
 * @param opts.stale 是否已连续多轮无看板写入
 * @returns 无未完成任务时返回空串（成功/简单轮不打扰）
 */
export function formatBoardMirror(items: BoardMirrorItem[], opts: { stale?: boolean } = {}): string {
  const open = openItems(items)
  if (open.length === 0) return ''
  const src = Array.isArray(items) ? items : []
  const doneCount = src.filter(it => it && String(it.status) === 'done').length
  const lines: string[] = []
  lines.push(`【任务看板 · 本会话】未完成 ${open.length} 项（已完成 ${doneCount}）`)
  for (const it of open) {
    lines.push(`- ${it.id || '（无 id）'} | ${it.desc}${it.status === 'running' ? ' · 执行中' : ''}`)
  }
  lines.push('推进规则（本轮必须照做）：')
  lines.push('1. 动手前 __AI__.tasks.start([id])；做完立刻 __AI__.tasks.complete([id])')
  lines.push('2. 必须传上面给出的 **id**，不要照抄长文本：模糊匹配可能未命中，看板会原地不动')
  lines.push('3. 确定做不成用 __AI__.tasks.fail([id]) 收尾，不许沉默留在待办')
  if (opts.stale) {
    lines.push(`⚠ 已连续 ${BOARD_STALE_ROUNDS} 轮看板状态未变化：本轮若推进了任一任务，务必在脚本里调用 start / complete / fail`)
  }
  return lines.join(NL)
}

// [board-mirror-stale-v1] 轮内指纹与停滞计数（模块级即可：一轮一次回传，无并发需求）
let _fingerprint = ''
let _staleStreak = 0

/** 测试用：重置停滞计数 */
export function resetBoardMirror(): void {
  _fingerprint = ''
  _staleStreak = 0
}

/** 当前停滞轮数（只读，供测试判据） */
export function boardStaleStreak(): number {
  return _staleStreak
}

/**
 * 拉取当前会话看板并渲染成回传块
 * [CONSTRAINT] sid 为空 / 请求失败 / 无未完成任务 ⇒ 空串，不抛、不阻断调用方
 * @param sid 缺省取 effectiveSessionId（与任务面板同一分桶）
 */
export async function fetchBoardMirror(sid?: string): Promise<string> {
  const useSid = String(sid || effectiveSessionId.value || '').trim()
  if (!useSid) return ''
  let items: BoardMirrorItem[] = []
  try {
    const r = await fetch(`/__ai/tasks?sid=${encodeURIComponent(useSid)}`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    })
    if (!r.ok) return ''
    const j = (await r.json()) as { items?: BoardMirrorItem[] }
    items = Array.isArray(j?.items) ? j.items : []
  } catch {
    return ''
  }
  const open = openItems(items)
  if (open.length === 0) {
    _fingerprint = ''
    _staleStreak = 0
    return ''
  }
  const fp = open.map(it => `${it.id}:${it.status}`).join('|')
  if (fp === _fingerprint) { _staleStreak += 1
  }
  else { _fingerprint = fp; _staleStreak = 0 }
  return formatBoardMirror(items, { stale: _staleStreak >= BOARD_STALE_ROUNDS })
}
