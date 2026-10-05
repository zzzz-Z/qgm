// [lessons-parse-shared-v1] lessons.md 的唯一条目解析实现（脚本侧与守卫侧共享）。
// [WHY] 此前 lessons-status.cjs 与 lessons-hygiene.node-test.ts 各写一份同构解析，
//   改一处必须同步另一处，极易分叉。抽到单一模块后，「两处口径一致」成为结构保证，
//   守卫只需断言两侧引用的是同一份实现（见 hygiene 的「共享解析器」用例）。
// [CHANGE-IMPACT] 纯函数、无副作用；调用方（scripts/lessons-status.cjs、hygiene 测试）
//   负责读盘与统计。
'use strict'

const NL = String.fromCharCode(10)
const STATES = ['VERIFIED', 'REJECTED', 'STALE']

/** 解析状态行：形如 `[VERIFIED] 2026-10-04 A · <证据>`。 */
function parseStateLine(text) {
  const t = String(text || '').trim()
  if (t.charAt(0) !== '[') return null
  const close = t.indexOf(']')
  if (close < 2) return null
  const token = t.slice(1, close).toUpperCase()
  if (!STATES.includes(token)) return null
  return { status: token, evidence: t.slice(close + 1).trim() }
}

/**
 * 把 lessons.md 解析成条目数组。
 * [lesson-fence-skip-v1] 跳过代码围栏内的内容：围栏里粘贴的原始输出含 `## 示例标题`，
 *   会被当成真条目 ⇒ 必然与它所引用的真条目近重复 ⇒ 必然打红 hygiene 闸门。
 * [CONSTRAINT] 与 lessons-status.cjs 共用同一份实现，不得在此文件之外另写解析。
 */
function parseLessons(raw) {
  const lines = String(raw || '').replace(/\r\n/g, NL).split(NL)
  const items = []
  let cur = null
  let expecting = false
  let inFence = false
  let fenceCh = ''
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const fm = line.match(/^\s*(`{3,}|~{3,})/)
    if (fm) {
      const ch = fm[1][0]
      if (!inFence) { inFence = true; fenceCh = ch }
      else if (ch === fenceCh) { inFence = false; fenceCh = '' }
      continue
    }
    if (inFence) continue
    if (line.slice(0, 3) === '## ') {
      const title = line.slice(3).trim()
      if (!title) continue
      cur = { title, status: 'UNVERIFIED', evidence: '', line: i + 1 }
      items.push(cur)
      expecting = true
      continue
    }
    if (!cur || !expecting) continue
    if (!line.trim()) continue
    expecting = false
    const st = parseStateLine(line)
    if (st) { cur.status = st.status; cur.evidence = st.evidence }
  }
  return items
}

module.exports = { parseLessons, parseStateLine, STATES }
