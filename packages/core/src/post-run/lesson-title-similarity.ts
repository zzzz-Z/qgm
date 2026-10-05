// [lesson-dedup-shared-v1] 采集侧与守卫侧共享的标题近重复判定。
// [WHY] 两侧此前口径不一：写入侧按归一化相等，闸门侧按二元组 Jaccard>=0.35，
//   宽的在写入、严的在闸门 ⇒ 合法写入也能立刻让 verify 变红。与「内联常量必须同构」同源。
// [CONSTRAINT] 阈值 0.35 是 ratchet，不得放宽。依据见 lessons-hygiene 用例注释。
export const LESSON_DUP_THRESHOLD = 0.35

export function normLessonTitle(t: string): string {
  return String(t).replace(/`/g, '').toLowerCase().replace(/[^a-z0-9\u4E00-\u9FA5]+/g, '')
}

export function lessonTitleBigrams(s: string): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i + 1 < s.length; i += 1) out.add(s.slice(i, i + 2))
  return out
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) { if (b.has(x)) inter += 1
  }
  return inter / (a.size + b.size - inter)
}

export function isNearDuplicateTitle(a: string, b: string): boolean {
  const ga = lessonTitleBigrams(normLessonTitle(a))
  const gb = lessonTitleBigrams(normLessonTitle(b))
  if (ga.size < 6 || gb.size < 6) return false
  return jaccardSimilarity(ga, gb) >= LESSON_DUP_THRESHOLD
}
