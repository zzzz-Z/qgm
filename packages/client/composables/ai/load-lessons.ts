// [load-lessons-v1] 把 `.ai-runner/lessons.md`（项目踩坑记录）注入 AI 决策回路。
// [WHY] lessons.md 此前只被 handoff-gen.cjs / session-start.cjs 做「统计读」——
//       生成交接报告、列出待复核条目——**从未进入 AI 的 prompt**。
//       于是「DONE 采集 → 入库 → 复核 → 蒸馏」这条链缺了最后一环：
//       前一条坑被记下来了，下一条同类的坑 AI 还是照踩。本模块补上这一环。
// [lessons-retrieval-v1] v2：有 query 时走服务端 BM25 检索 top-k（POST /lessons/match），
//       替代「从文件尾截断」（旧行为只覆盖 ≈5.3%，95 条 [VERIFIED] 基本不在场）。
// [CONSTRAINT] 失败 / 空文件 / 超预算一律降级为空串，绝不阻断首问与循环首轮；
//              检索不可用时**回退尾截断**（不得变为不注入），超预算时按条目边界截断。
// [CHANGE-IMPACT] 被 session-prompt.ts 的两个 prompt 构建函数消费；调整 LESSONS_BUDGET 会改变首问长度。

/** lessons 注入预算（字符）。超出后按条目边界截断，宁少勿滥。 */
export const LESSONS_BUDGET = 6000

/**
 * 掐掉文件头部的 `>` 引用块引言。
 * [WHY] 引言是写给「维护者」的采集/复核/蒸馏协议，对 AI 完成当前任务没有信息量，
 *       却固定占掉约 1KB 预算。只保留 `## 标题` 起的条目正文。
 * [CONSTRAINT] 找不到 `## ` 时返回空串 —— 不要退回整篇（那会把引言也灌进去）
 */
function stripPreface(md: string): string {
  const i = md.search(/^##\s/m)
  return i >= 0 ? md.slice(i) : ''
}

/**
 * 按 `## 标题` 切分条目
 * [CONSTRAINT] 与 attach-ws.ts 的入库去重、lessons-status.cjs 的统计口径一致，都用 `^## `
 */
function splitEntries(body: string): string[] {
  const out: string[] = []
  let cur: string[] = []
  for (const line of body.split(/\r?\n/)) {
    if (/^##\s/.test(line) && cur.length) {
      out.push(cur.join('\n').trimEnd())
      cur = []
    }
    cur.push(line)
  }
  const tail = cur.join('\n').trim()
  if (tail) out.push(tail)
  return out.filter(Boolean)
}

/** 从服务端检索命中的条目（形状与 /__ai/lessons/match 出参一致） */
interface MatchedLesson {
  title: string
  body: string
  state: string
  score: number
  matched: string[]
}

/**
 * 按任务文本检索相关 lessons 条目。
 * [CONSTRAINT] 查询为空 / 请求失败 / 零命中 → 返回空数组，绝不抛错阻断首问。
 * @param query 当前任务文本（通常是 goal / summary）
 * @param limit 最多返回条数
 */
async function matchLessons(query: string, limit = 3): Promise<MatchedLesson[]> {
  const q = String(query || '').trim()
  if (!q) return []
  try {
    const r = await fetch('/__ai/lessons/match', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify({ query: q, limit }),
    })
    const j = await r.json()
    if (j && j.ok && Array.isArray(j.matches)) return j.matches as MatchedLesson[]
  } catch { /* 检索不可用 → 走回退 */ }
  return []
}

/** 读取 .ai-runner/lessons.md 原文；失败返回 '' */
async function readLessonsFile(): Promise<string> {
  try {
    const r = await fetch('/__ai/files/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['.ai-runner/lessons.md'] }),
    })
    const j = await r.json()
    const files = Array.isArray(j?.files) ? j.files : []
    const hit = files.find((f: { path?: string }) => String(f?.path || '').endsWith('lessons.md'))
    if (hit && !hit.error && hit.content) return String(hit.content)
  } catch { return '' }
  return ''
}

/** 拼装注入块的公共文件头（图例必须保留） */
function buildHead(injected: number, total: number): string[] {
  const head = [
    '# 历史踩坑记录（.ai-runner/lessons.md）',
    '',
    '> 本项目**既往踩过的坑**，按标题去重、append-only。生成脚本前先扫一遍，避免重踩。',
    '> 状态行（`## 标题` 后首个非空行）含义 —— **不看这份图例会误读**：',
    '> - `[VERIFIED]` 已亲跑确证 ⇒ 可当铁律',
    '> - `[REJECTED]` 已被实测推翻 ⇒ **正文描述是错的，不要照做**',
    '> - `[STALE]` 曾为真但机制已改 ⇒ **现在已不适用，别照着修**',
    '> - `（待复核）` 或无状态行 ⇒ 尚未复核，可参考、勿当铁律',
  ]
  if (injected < total) head.push(`> ⚠️ 条目过多，此处仅注入最近 ${injected}/${total} 条；完整见 \`.ai-runner/lessons.md\`。`)
  head.push('')
  return head
}

/**
 * 检索路径：命中条目 **verbatim** 注入（含首行状态行，不得剥离）。
 * [CONSTRAINT] 命中再多也不得越 `LESSONS_BUDGET` 预算（判据②）。
 */
function buildFromMatches(matches: MatchedLesson[]): string {
  if (!matches.length) return ''
  const picked: string[] = []
  let used = 0
  for (const m of matches) {
    // 命中条目按 `## 标题` + 正文逐字还原（正文已含状态行）
    const entry = `## ${m.title}\n${m.body}`
    if (used + entry.length > LESSONS_BUDGET && picked.length > 0) break
    picked.push(entry)
    used += entry.length + 2
  }
  if (!picked.length) return ''
  const head = buildHead(picked.length, matches.length)
  return `<file path=".ai-runner/lessons.md">\n${head.join('\n')}${picked.join('\n\n')}\n</file>`
}

/**
 * 回退路径：从最新（文件尾）往前累计，**待复核条目占比封顶**。
 * [CONSTRAINT] 必须等价旧行为——不得把「检索失败」变成「不注入」。
 */
function buildFromTail(md: string): string {
  const entries = splitEntries(stripPreface(md))
  if (!entries.length) return ''

  // [lessons-window-hygiene-v1] 从最新（文件尾）往前累计，但**待复核条目占比封顶**：
  //   台账 append-only ⇒ 新采集（缺省待复核）必堆尾部，纯从尾截会让 AI 读到 100% 未验证内容。
  //   封顶后仍保留时间顺序（unshift），只是跳过会超配额的 pending 条目、继续往前找已复核的。
  //   [CONSTRAINT] 窗口只剩 1 条时豁免（nextTotal>1 才判）——否则全新库会一条都注不进。
  const MAX_PENDING_RATIO = 0.4
  const isPendingEntry = (e: string): boolean => {
    const first = e.split('\n').slice(1).find(l => l.trim() !== '') || ''
    return !/^\[(?:VERIFIED|REJECTED|STALE)\]/i.test(first.trim())
  }
  const picked: string[] = []
  let used = 0
  let pendingN = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (picked.length && used + e.length > LESSONS_BUDGET) break
    const isP = isPendingEntry(e)
    const nextTotal = picked.length + 1
    if (isP && nextTotal > 1 && (pendingN + 1) / nextTotal > MAX_PENDING_RATIO) continue
    picked.unshift(e)
    used += e.length + 2
    if (isP) pendingN++
  }
  const truncated = picked.length < entries.length
  const head = buildHead(truncated ? picked.length : entries.length, entries.length)
  return `<file path=".ai-runner/lessons.md">\n${head.join('\n')}${picked.join('\n\n')}\n</file>`
}

/**
 * 读取并构造 lessons 注入块。
 * [CONSTRAINT] 任何异常（网络 / 解析 / 无内容）都返回 '' —— 调用方据此自然降级。
 * @param query 当前任务文本；有值时走检索，为空或检索不可用时回退尾截断
 * @returns 可直接拼进 prompt 的 `<file>` 块；无内容时为 ''
 */
export async function buildLessonsBlock(query?: string): Promise<string> {
  const q = String(query || '').trim()
  if (q) {
    const matches = await matchLessons(q)
    if (matches.length) return buildFromMatches(matches)
    // 检索零命中 / 失败 → 落回尾截断（不得空注入）
  }

  const md = await readLessonsFile()
  if (!md.trim()) return ''
  return buildFromTail(md)
}
