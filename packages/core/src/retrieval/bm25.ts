// [retrieval-bm25-v1] BM25 核心：分词 / 停用词 / df 截断 / 分数下限，skills 与 lessons 共用。
// [WHY] 从 skills/retriever.ts 抽出，避免第二份分词表必然漂移（SSOT 纪律）。
// [CONSTRAINT] 行为必须与抽取前逐字一致——CJK_STOP 已知怪值（'之的'、重复的 '了的'、'和和'）原样保留，不得清理。

export const K1 = 1.2
export const B = 0.75
export const MIN_LATIN_LEN = 2
export const MAX_MATCHED = 6
// [df-cutoff-v1] 出现在超过此比例文档中的词，视为零区分度直接丢弃。
// WHY: idf 的 +1 平滑保证「所有文档都含」时 idf 仍为 0.0339 > 0，结构上无法靠分数过滤。
export const DF_RATIO_MAX = 0.6
// [score-floor-v1] 低于此分视为「无实质重叠」，宁可不注入也不塞噪音。
export const SCORE_FLOOR = 1.0

// [stopwords-v1] 高频功能词与通用动词，它们在技能描述里无区分意义。
// CONSTRAINT: 只收录「跨领域都出现」的词；领域词（如 test/build）保留，它们有区分度。
export const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'if',
  'then',
  'else',
  'for',
  'of',
  'to',
  'in',
  'on',
  'at',
  'by',
  'with',
  'without',
  'from',
  'into',
  'onto',
  'over',
  'under',
  'about',
  'as',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'do',
  'does',
  'did',
  'doing',
  'have',
  'has',
  'had',
  'having',
  'will',
  'would',
  'can',
  'could',
  'should',
  'may',
  'might',
  'must',
  'shall',
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
  'use',
  'used',
  'using',
  'uses',
  'when',
  'where',
  'which',
  'who',
  'whom',
  'what',
  'how',
  'why',
  'not',
  'no',
  'yes',
  'all',
  'any',
  'both',
  'each',
  'few',
  'more',
  'most',
  'other',
  'some',
  'such',
  'than',
  'too',
  'very',
  'just',
  'also',
  'only',
  'own',
  'same',
  'so',
  'up',
  'out',
  'off',
  'again',
  'further',
  'once',
  'you',
  'your',
  'we',
  'our',
  'they',
  'their',
  'he',
  'she',
  'his',
  'her',
  'them',
  'i',
  'me',
  'my',
  'work',
  'working',
  'works',
  'need',
  'needs',
  'needed',
  'make',
  'makes',
  'made',
  'get',
  'gets',
  'got',
  'like',
  'want',
  'wants',
  'help',
  'helps',
  'helping',
  'new',
  'old',
  'good',
  'bad',
  'well',
  'way',
  'ways',
])

// [cjk-stopwords-v1] 中文功能词按 bigram 形态收录——分词产出的是二元组，
// 所以「的」「了」等单字不会单独出现，但「的时」「时候」这类会。
export const CJK_STOP = new Set([
  '的时',
  '时候',
  '一个',
  '什么',
  '怎么',
  '如何',
  '可以',
  '需要',
  '使用',
  '进行',
  '通过',
  '对于',
  '以及',
  '并且',
  '或者',
  '但是',
  '因为',
  '所以',
  '如果',
  '那么',
  '这个',
  '那个',
  '这些',
  '那些',
  '我们',
  '你们',
  '他们',
  '它们',
  '自己',
  '之的',
  '了的',
  '了的',
  '是在',
  '在了',
  '和和',
])

export function tokenize(text: string): string[] {
  const out: string[] = []
  const src = String(text || '').toLowerCase()
  if (!src) return out

  const latin = src.match(/[a-z0-9_]+/g) || []
  for (const w of latin) {
    if (w.length < MIN_LATIN_LEN) continue
    if (STOPWORDS.has(w)) continue
    out.push(w)
  }

  const cjk = src.match(/[\u4E00-\u9FFF\u3040-\u30FF]+/g) || []
  for (const seg of cjk) {
    if (seg.length === 1) { out.push(seg); continue }
    for (let i = 0; i + 1 < seg.length; i += 1) {
      const bg = seg.slice(i, i + 2)
      if (CJK_STOP.has(bg)) continue
      out.push(bg)
    }
  }

  return out
}

export interface FieldStats {
  tf: Map<string, number>
  len: number
}

export function termFreq(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>()
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1)
  return tf
}

export function idfOf(df: number, total: number): number {
  return Math.log((total - df + 0.5) / (df + 0.5) + 1)
}

export function scoreField(q: string[], field: FieldStats, df: Map<string, number>, total: number, avgLen: number): number {
  if (!field.len || !q.length) return 0
  let sum = 0
  for (const t of q) {
    const tf = field.tf.get(t)
    if (!tf) continue
    const idf = idfOf(df.get(t) || 0, total)
    const denom = tf + K1 * (1 - B + B * (field.len / (avgLen || 1)))
    sum += idf * ((tf * (K1 + 1)) / denom)
  }
  return sum
}

// [matched-span-v1] 把命中 token 在原文里的区间取并集，避免跨词边界的 CJK bigram 碎片进入 matched。
// WHY: CJK bigram 切分对「浏览器」产出 [浏览, 览器] 两片，直接返回 token 会把碎片塞进提示词。
// CONSTRAINT: 只在 query 小写串上定位（tokenize 产出的 token 是小写），不改 tokenize 本体。
// CHANGE-IMPACT: matched 只影响展示与诊断，不参与打分，因此本改动不改召回。
export function pickMatchedSpans(q: string, terms: string[], pool: Set<string>, limit: number): string[] {
  if (!q || !terms.length) return []
  const iv: Array<[number, number]> = []
  for (const t of terms) {
    if (!pool.has(t)) continue
    for (let i = q.indexOf(t); i >= 0; i = q.indexOf(t, i + 1)) {
      // [matched-span-latin-v1] 拉丁 token 必然以完整词出现；落在词边界外的命中是子串误命中。
      // WHY: 不校验时 test 会在 vitest 内部再命中一次，matched 出现重复条目 ["test","test"]。
      // CONSTRAINT: CJK bigram 定义上跨边界，不做此校验。
      if (/^[a-z0-9_]+$/.test(t)) {
        const before = i > 0 ? q[i - 1] : ''
        const after = i + t.length < q.length ? q[i + t.length] : ''
        if (/[a-z0-9_]/.test(before) || /[a-z0-9_]/.test(after)) continue
      }
      iv.push([i, i + t.length])
    }
  }
  if (!iv.length) return []
  iv.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const spans: Array<[number, number]> = []
  for (const [s, e] of iv) {
    const last = spans[spans.length - 1]
    if (last && s <= last[1]) last[1] = Math.max(last[1], e)
    else spans.push([s, e])
  }
  return spans.map(([s, e]) => q.slice(s, e)).slice(0, limit)
}
