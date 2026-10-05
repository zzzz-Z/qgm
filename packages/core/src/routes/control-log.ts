// [control-log-v1] 控制面留痕：/run 的**前置拒收**与 /tasks 的**看板写入**各留一条结构化日志。
//
// [WHY] 这两条通道此前在服务端**零留痕**，而它们恰好是两个最高频用户可见故障的现场：
//
//   · 「脚本频繁被截断」——`/run` 的 4xx（空脚本 / 脚本头契约 / 语法）发生在 NDJSON 流开始**之前**，
//     写不进 `runner.jsonl`（那条日志只在流内写）。SYSTEM.md §10 因此明文写着
//     「4xx 且无 runId = 脚本根本没有执行…此时不存在任何运行日志可翻」——
//     于是这一类故障的**频率、体积分布、所属 sid、是截断还是真语法错**在服务端全部不可测量，
//     只能采信被驱动 AI 的自述 ⇒ 既无法定界，也无法为修复做回归验证。
//
//   · 「任务状态不更新」——`/tasks` 的写请求没有日志。2026-10-05 实测现场：
//     `state.json` 里某 sid 桶前 21 项 done、后 10 项全 pending；`logs/2026-10-05.jsonl` 显示
//     那两轮只有 `push`、之后除两条 `list` 外**没有任何 start/complete**。
//     同一实例上 curl 亲测 push→start→complete 三态全部正确落盘 ⇒ 服务端状态机无缺陷，
//     真因是「收尾调用根本没发出」。但「AI 声称已 complete 而过没发」既不能证实也不能证伪——
//     因为看板写请求本身不留痕。本条日志就是那个判据。
//
// [CONSTRAINT] **只加日志，不改行为**：三个 400 分支的响应体形状被客户端锁死
//   （`useRunner` 的 truncated/scriptSize 结构化提升 + `truncationFeedback` 用例），一律不动。
// [CONSTRAINT] 字段值必须单行化：jsonl 一行一条，正文里的换行会破坏结构
//   （见 `writeChannelLog` 的同名约束），故 head / error / reason 全部过 `toSingleLine`。
import { measureScriptSize } from '../post-run/script-check.js'

/** /run 前置拒收的成因分类（与 run.ts 的三个 400 分支一一对应） */
export type RejectKind = 'empty' | 'head-contract' | 'syntax'

/** 体积口径：`raw` = 请求体原文；`effective` = 剥掉 shebang 后的实际执行体（与响应里的 scriptSize 同口径） */
export type SizeScope = 'raw' | 'effective'

/** 被拒脚本的留痕条目 */
export interface RejectLogEntry {
  channel: 'run'
  kind: RejectKind
  /** 请求体里的会话 id（空串表示客户端未传） */
  sid: string
  sizeScope: SizeScope
  bytes: number
  lines: number
  /** 是否超出 SYSTEM.md §10 预算（行数或字节任一超出） */
  overBudget: boolean
  /** 仅 syntax 分支：结构未闭合 + 截断族错误消息 ⇒ true */
  truncated?: boolean
  /** 仅 head-contract 分支：HeadResult.reason */
  reason?: string
  /** 仅 syntax 分支：vm.Script 报出的错误消息（含前 80 字符预览） */
  error?: string
  /** 脚本前 200 字符（单行化），用于肉眼判断「这份脚本是不是本来就写歪了」 */
  head: string
}

/**
 * 把任意文本压成单行并限长
 * [WHY] jsonl 一行一条 ⇒ 正文换行会破坏结构；控制字符（\r / \t / 退格）会把日志行渲染成乱码。
 *   用字符码位过滤而不是控制字符正则：`no-control-regex` 一类的 lint 规则会拒绝后者，
 *   且「保留 \n 占位、其余见不得光的码位一律丢弃」比正则更直白。
 * [CONSTRAINT] 只保留 `\n` 与可打印字符（码位 ≥ 0x20），其余丢弃
 * @param s 原始文本
 * @param max 最大长度（超出截断并加省略号）
 */
export function toSingleLine(s: string, max: number): string {
  const one = Array.from(String(s || ''))
    .filter(c => c === '\n' || (c.codePointAt(0) as number) >= 0x20)
    .join('')
    .split('\n')
    .join('\\n')
  return one.length > max ? `${one.slice(0, max)}…` : one
}

/**
 * 组装被拒脚本的日志条目（纯函数，无 IO，便于值级单测）
 * [WHY] 拒收条目的价值全在字段上：`sizeScope` 与 `overBudget` 回答「这轮本来就超预算吗」，
 *   `truncated` 回答「是通道故障还是写错了」，`head` 回答「脚本头长什么样」。
 * @param script 被拒的脚本文本（syntax 分支传 effectiveScript，其余传原文）
 * @param kind 拒收成因
 * @param extra 附加字段
 * @param extra.sid 会话 id（来自 /run 请求体）
 * @param extra.reason 脚本头契约违规原因（仅 head-contract 分支）
 * @param extra.error vm.Script 报出的错误消息（仅 syntax 分支）
 * @param extra.truncated 是否判定为截断（仅 syntax 分支）
 * @param extra.sizeScope 体积口径 raw / effective
 */
export function buildRejectEntry(
  script: string,
  kind: RejectKind,
  extra: { sid?: string, reason?: string, error?: string, truncated?: boolean, sizeScope?: SizeScope } = {},
): RejectLogEntry {
  const size = measureScriptSize(String(script || ''))
  const entry: RejectLogEntry = {
    channel: 'run',
    kind,
    sid: String(extra.sid || ''),
    sizeScope: extra.sizeScope || 'raw',
    bytes: size.bytes,
    lines: size.lines,
    overBudget: size.overBudget,
    head: toSingleLine(script, 200),
  }
  if (extra.truncated !== undefined) entry.truncated = extra.truncated === true
  if (extra.reason) entry.reason = toSingleLine(extra.reason, 200)
  if (extra.error) entry.error = toSingleLine(extra.error, 300)
  return entry
}

/** 看板写请求的留痕条目 */
export interface BoardLogEntry {
  channel: 'tasks'
  sid: string
  mode: string
  /** 本次提交的目标键（push/complete/start/fail 的入参）；set 模式为 items 条数说明 */
  keys: string[]
  /** 落盘后各状态计数 —— 「AI 说它改过了」与「看板上真的变了」靠这组数对齐 */
  pending: number
  running: number
  done: number
  failed: number
  /** 非阻断告警原文（含「complete 未命中: …」「deps 未完成: …」「version-conflict-retry」） */
  warnings: string[]
  /** CAS 重试耗尽 = 本次变更可能未落盘 */
  degraded: boolean
  attempts: number
}

/** 从请求体里取出本次提交的目标键（与 task-store 的 mode 推导同序） */
export function boardKeysOf(body: Record<string, unknown>): string[] {
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])
  for (const k of ['pushTodo', 'complete', 'start', 'fail', 'todo'] as const) {
    const got = arr(body[k])
    if (got.length) return got
  }
  if (Array.isArray(body.items)) return [`<items:${body.items.length}>`]
  return []
}

/** 组装看板写请求的日志条目（纯函数，无 IO） */
export function buildBoardEntry(
  body: Record<string, unknown>,
  out: { warnings?: string[], degraded?: boolean, attempts?: number, state?: { items?: Array<{ status?: string }> } },
  sid?: string,
): BoardLogEntry {
  const items = out.state?.items || []
  const count = (s: string) => items.filter(it => it && it.status === s).length
  return {
    channel: 'tasks',
    sid: String(sid || ''),
    mode: String(body.mode || '(auto)'),
    keys: boardKeysOf(body).map(k => toSingleLine(k, 120)),
    pending: count('pending'),
    running: count('running'),
    done: count('done'),
    failed: count('failed'),
    warnings: (out.warnings || []).map(w => toSingleLine(w, 200)),
    degraded: out.degraded === true,
    attempts: Number(out.attempts) || 0,
  }
}
