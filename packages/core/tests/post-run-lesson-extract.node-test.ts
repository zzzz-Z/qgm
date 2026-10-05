// [lesson-autocapture-v1] DONE 总结 → lessons.md 自动提取的解析与去重测试
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { appendLessons, extractLessons } from '../../../packages/core/src/post-run/lesson-extract.js'
import { isNearDuplicateTitle } from '../../../packages/core/src/post-run/lesson-title-similarity.js'

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const NL = String.fromCharCode(10)
const WIDE = String.fromCharCode(0xFF1A)

test('extractLessons: 无踩坑记录段 → 空数组', () => {
  assert.deepEqual(extractLessons(`## 结论${NL}完成`), [])
})

test('extractLessons: 空字符串 → 空数组', () => {
  assert.deepEqual(extractLessons(''), [])
})

test('extractLessons: 识别 ## 踩坑记录 下的 ### 子标题', () => {
  const src = [
    '## 结论',
    '一句话总结',
    '## 踩坑记录',
    '### 第一个坑',
    '坑 A 的描述',
    '### 第二个坑',
    '坑 B 的描述',
    '## 遗留风险',
    '- 无',
  ].join(NL)
  const items = extractLessons(src)
  assert.equal(items.length, 2)
  assert.equal(items[0].title, '第一个坑')
  assert.equal(items[0].body, '坑 A 的描述')
  assert.equal(items[1].title, '第二个坑')
})

test('extractLessons: 识别 ### 踩坑记录 层级（列表式条目）', () => {
  const src = [
    '## 结论',
    '### 踩坑记录',
    '- **坑一号**：描述一',
  ].join(NL)
  const items = extractLessons(src)
  assert.equal(items.length, 1)
  assert.equal(items[0].title, '坑一号')
  assert.equal(items[0].body, '描述一')
})

test('extractLessons: 列表形式 - **标题**：正文', () => {
  const src = [
    '## 踩坑记录',
    '- **正则回溯**：无界量词相邻会触发 lint',
    '- **缓存污染**：eslint 报错行号与实际不符',
  ].join(NL)
  const items = extractLessons(src)
  assert.equal(items.length, 2)
  assert.equal(items[0].title, '正则回溯')
  assert.equal(items[1].title, '缓存污染')
})

test('extractLessons: 全角冒号分隔', () => {
  const src = [
    '## 踩坑记录',
    `- **全角分隔**${WIDE}正文内容`,
  ].join(NL)
  const items = extractLessons(src)
  assert.equal(items.length, 1)
  assert.equal(items[0].title, '全角分隔')
  assert.equal(items[0].body, '正文内容')
})

test('extractLessons: 段落终止于同级或更高级标题', () => {
  const src = [
    '## 踩坑记录',
    '### 唯一坑',
    '坑描述',
    '## 后续章节',
    '### 不该被提取',
  ].join(NL)
  const items = extractLessons(src)
  assert.equal(items.length, 1)
  assert.equal(items[0].title, '唯一坑')
})

test('extractLessons: 踩坑记录段为空 → 空数组', () => {
  const src = `## 踩坑记录${NL}## 后续`
  assert.deepEqual(extractLessons(src), [])
})

function withTempRoot(fn: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-test-'))
  try {
    fs.mkdirSync(path.join(root, '.ai-runner'), { recursive: true })
    fn(root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('appendLessons: 文件缺失时不写入', () => {
  withTempRoot((root) => {
    const n = appendLessons([{ title: 'X', body: 'Y' }], root)
    assert.equal(n, 0)
  })
})

test('appendLessons: 追加新条目并保留原有内容', () => {
  withTempRoot((root) => {
    const file = path.join(root, '.ai-runner', 'lessons.md')
    fs.writeFileSync(file, `# Lessons${NL}${NL}## 已有条目${NL}${NL}原内容${NL}`, 'utf8')
    const n = appendLessons([{ title: '新条目', body: '新内容' }], root)
    assert.equal(n, 1)
    const after = fs.readFileSync(file, 'utf8')
    assert.ok(after.includes('## 已有条目'))
    assert.ok(after.includes('原内容'))
    assert.ok(after.includes('## 新条目'))
    assert.ok(after.includes('新内容'))
  })
})

test('appendLessons: 标题重复时跳过', () => {
  withTempRoot((root) => {
    const file = path.join(root, '.ai-runner', 'lessons.md')
    fs.writeFileSync(file, `# Lessons${NL}${NL}## 重复标题${NL}${NL}旧内容${NL}`, 'utf8')
    const n = appendLessons([{ title: '重复标题', body: '新内容' }], root)
    assert.equal(n, 0)
    const after = fs.readFileSync(file, 'utf8')
    assert.ok(after.includes('旧内容'))
    assert.ok(!after.includes('新内容'))
  })
})

test('appendLessons: 混合条目只追加未重复部分', () => {
  withTempRoot((root) => {
    const file = path.join(root, '.ai-runner', 'lessons.md')
    fs.writeFileSync(file, `# Lessons${NL}${NL}## 存在A${NL}`, 'utf8')
    const n = appendLessons([
      { title: '存在A', body: 'x' },
      { title: '新增B', body: 'y' },
    ], root)
    assert.equal(n, 1)
  })
})

// [lesson-title-boundary-v1] 标题边界：标题内部含冒号时不得在**首个**冒号处腰斩。
// 承重：把切分改回「取首个冒号」，下面两条即变红（这正是 .ai-runner/lessons.md 里
// 8 条标题结构破损的成因：`## …默认 \`shell` + 孤儿行 `false\`：…`）。
test('extractLessons: 无粗体列表按末冒号切分（标题含冒号不腰斩）', () => {
  const src = ['### 踩坑记录', '- 只跑 tsc：漏了 test:tsc：本轮教训'].join(NL)
  const items = extractLessons(src)
  assert.equal(items.length, 1)
  assert.equal(items[0].title, '只跑 tsc：漏了 test:tsc')
  assert.equal(items[0].body, '本轮教训')
})

test('extractLessons: 全角冒号同样按末冒号切分', () => {
  const src = ['### 踩坑记录', `- 结论${WIDE}含${WIDE}正文`].join(NL)
  const items = extractLessons(src)
  assert.equal(items.length, 1)
  assert.equal(items[0].title, `结论${WIDE}含`)
  assert.equal(items[0].body, '正文')
})

test('extractLessons: 闭合粗体优先于冒号（**A：B**：正文）', () => {
  const src = ['### 踩坑记录', `- **A${WIDE}B**${WIDE}正文`].join(NL)
  const items = extractLessons(src)
  assert.equal(items.length, 1)
  assert.equal(items[0].title, `A${WIDE}B`)
  assert.equal(items[0].body, '正文')
})

// 正文里含冒号是常态（「原因：…」「做法：…」）。粗体标题必须按**闭合粗体**切，
// 否则「末冒号」会切进正文里，把正文前半截并进标题。
test('extractLessons: 正文含冒号时粗体标题仍按闭合粗体切', () => {
  const src = ['### 踩坑记录', `- **临时目录要先 realpath**${WIDE}原因${WIDE}macOS 的 /tmp 是软链`].join(NL)
  const items = extractLessons(src)
  assert.equal(items.length, 1)
  assert.equal(items[0].title, '临时目录要先 realpath')
  assert.equal(items[0].body, `原因${WIDE}macOS 的 /tmp 是软链`)
})

// [lesson-dedup-norm-v1] 归一化去重：差异只在空白/反引号/冒号半全角/标点时视为同一条。
test('appendLessons: 近重复标题（只差反引号与冒号半全角）被挡住', () => {
  withTempRoot((root) => {
    const file = path.join(root, '.ai-runner', 'lessons.md')
    fs.writeFileSync(file, `# Lessons${NL}${NL}## \`shell: false\` 默认${NL}${NL}旧内容${NL}`, 'utf8')
    const n = appendLessons([{ title: 'shell：false 默认', body: '新内容' }], root)
    assert.equal(n, 0)
    assert.ok(!fs.readFileSync(file, 'utf8').includes('新内容'))
  })
})

test('appendLessons: 归一化不得吞掉真正的新标题（反例控制，防判据恒真）', () => {
  withTempRoot((root) => {
    const file = path.join(root, '.ai-runner', 'lessons.md')
    fs.writeFileSync(file, `# Lessons${NL}${NL}## \`shell: false\` 默认${NL}`, 'utf8')
    assert.equal(appendLessons([{ title: '另一个完全不同的坑', body: 'y' }], root), 1)
  })
})

test('往返：DONE 提取 → 落盘 → 再提取，标题不腰斩且第二次被去重', () => {
  withTempRoot((root) => {
    const file = path.join(root, '.ai-runner', 'lessons.md')
    fs.writeFileSync(file, `# Lessons${NL}`, 'utf8')
    const done = ['### 踩坑记录', '- shell: false 是默认：正文内容'].join(NL)

    const items = extractLessons(done)
    assert.equal(items.length, 1)
    assert.equal(items[0].title, 'shell: false 是默认')
    assert.equal(appendLessons(items, root), 1)

    // 同一段 DONE 再来一次：归一化去重必须挡住（否则每轮 DONE 都会再追加一条）
    assert.equal(appendLessons(extractLessons(done), root), 0)

    const heads = fs.readFileSync(file, 'utf8').split(NL).filter(l => l.startsWith('## '))
    assert.deepEqual(heads, ['## shell: false 是默认'])
  })
})

// [lesson-colon-in-code-v1] 行内代码里的冒号不得当标题/正文分界。
// 承重：把 lastSeparatorColon 换回 Math.max(lastIndexOf(':'), lastIndexOf('：'))，
// 下面这条即变红——标题会被从 `docs:verify` 中间劈开，反引号数变奇数。
test('extractLessons: 行内代码里的冒号不当分界（不劈开 docs:verify）', () => {
  const src = [
    '### 踩坑记录',
    `- \`docs/\` 是 git 追踪区，\`.ai-runner/\` 不是${WIDE}新增 \`docs/*.md\` 必须同步进 \`docs/DOCS-INDEX.md\`，否则 \`docs:verify\` 会失败。`,
  ].join(NL)
  const items = extractLessons(src)
  assert.equal(items.length, 1)
  assert.equal(items[0].title, '`docs/` 是 git 追踪区，`.ai-runner/` 不是')
  assert.equal((items[0].title.match(/`/g) || []).length % 2, 0, `标题反引号必须配对：${items[0].title}`)
  assert.ok(items[0].body.includes('docs:verify'), '正文须完整保留，而不是把半截行内代码并进标题')
})

// [lesson-inline-code-runs-v1] 多反引号定界（两连反引号）的代码段内的冒号同样不得当分界。
// 承重：把 insideInlineCode 改回「数单个反引号」的奇偶即变红（双反引号定界贡献 2 个计数，
// 段内冒号被误判成段外）。
// [why-this-shape] 必须让**段内的冒号就是最右的冒号**。若行内还有更靠右的段外冒号，
// 右到左的扫描会先命中它，旧口径也能「碰巧」给出正确标题 —— 那种用例是真空判据（本轮实测踩过）。
const TICK = String.fromCharCode(96)

test('extractLessons: 段内冒号在最右时，双反引号代码段不得被劈开', () => {
  const src = [
    '### 踩坑记录',
    `- 说明：段内 ${TICK}${TICK}a:b${TICK}${TICK} 结尾。`,
  ].join(NL)
  const items = extractLessons(src)
  assert.equal(items.length, 1)
  assert.equal(items[0].title, '说明', `标题应在段外冒号处切开，实际：${items[0].title}`)
  // [承重判据-v2] 这里原先写的是 `(title.match(/' + T + '/g) || []).length % 2`：
  //   那条"正则"匹配的是**字面文本** `' + T + '` —— `T` 从未在本文件定义过，它落在正则字面量里
  //   既不是标识符引用、也不是插值，所以既不报错也不生效。标题里没有这个序列 ⇒ 命中数恒 0
  //   ⇒ 0 % 2 === 0 ⇒ **永真**，是一条纯真空判据（eslint --fix 后来又把它"优化"成
  //   /' {2,}T {2,}'/g，依旧永真，只是更难看出坏）。
  //   改成对**正文定界符**的断言：这才是本用例要守的东西，且旧口径下会红
  //   ——「innerText 保留」不等于「定界符保留」。
  assert.ok(
    items[0].body.includes(`${TICK}${TICK}a:b${TICK}${TICK}`),
    `双反引号定界必须连定界符一起原样留在正文，实际正文：${JSON.stringify(items[0].body)}`,
  )
})

// [lesson-title-sanitize-v1] 写入边界的不变量：任何来源的破损标题都必须被规范成
// 「单行 + 反引号配对」，否则会击穿 lessons-hygiene 守卫。
// 承重：删掉 appendLessons 里的 sanitizeTitle 调用即变红（落盘标题反引号变奇数）。
test('appendLessons: 跨行 / 悬空反引号的标题落盘前被规范', () => {
  withTempRoot((root) => {
    const file = path.join(root, '.ai-runner', 'lessons.md')
    fs.writeFileSync(file, `# Lessons${NL}`, 'utf8')
    assert.equal(appendLessons([{ title: `半个 \`docs${NL}继续`, body: 'y' }], root), 1)
    const heads = fs.readFileSync(file, 'utf8').split(NL).filter(l => l.startsWith('## '))
    assert.equal(heads.length, 1)
    assert.equal((heads[0].match(/`/g) || []).length % 2, 0, `标题反引号必须配对：${heads[0]}`)
  })
})
// [lesson-dedup-shared-v1] 段一（工单 WO-20261005-03）：写入侧必须拦住闸门侧会判红的近重复。
// 承重：把 isNearDuplicateTitle 换成 () => false（恒不命中），本用例变红——
//   近重复条目会被当作新条写入，落盘后 lessons-hygiene 立即判红。
test('appendLessons: 近重复标题并入既有条目，不新增', () => {
  withTempRoot((root) => {
    const file = path.join(root, '.ai-runner', 'lessons.md')
    const seed = [
      '# Lessons',
      '',
      '## docs/plan 被 gitignore 但不在 eslint ignores 里',
      '',
      '原始正文。',
      '',
    ].join(NL)
    fs.writeFileSync(file, seed, 'utf8')
    // 近重复标题：Jaccard >= 0.35（实测 0.41）但归一化后不相等
    const near = 'docs/plan 被 gitignore 但 @antfu/eslint-config 会自动忽略'
    const n = appendLessons([{ title: near, body: '被并入的补充内容。' }], root)
    assert.equal(n, 1, '并入应计 1')
    const after = fs.readFileSync(file, 'utf8')
    const heads = after.split(NL).filter(l => l.startsWith('## '))
    assert.equal(heads.length, 1, '不得新增独立条目')
    assert.ok(after.includes('补充（'), '必须留痕：并入内容应追加到既有条目正文')
    assert.ok(after.includes('被并入的补充内容。'), '被并入正文不得丢失')
  })
})
// [lesson-dedup-shared-v1] 段一：写入侧拦住闸门侧会判红的近重复。
// 承重：把 isNearDuplicateTitle 换成 () => false 即变红。

// [scenario-B-merge-v1] 段一场景 B：同批两条近重复、原文件无该标题。
// 旧实现在写入阶段按 key 找行，key 若是本轮新标题则命中不了 ⇒ 被并入正文蒸发。
// 承重：本用例断言磁盘上必须含 B 的正文，而不只是「标题数 == 1」。
test('appendLessons: 同批两条近重复且原文件无该标题，B 的正文不得丢失', () => {
  withTempRoot((root) => {
    const file = path.join(root, '.ai-runner', 'lessons.md')
    fs.writeFileSync(file, `# Lessons${NL}`, 'utf8')
    const A = 'docs/plan 被 gitignore 但不在 eslint ignores 里'
    const B = 'docs/plan 被 gitignore 但 @antfu/eslint-config 会自动忽略'
    assert.ok(isNearDuplicateTitle(A, B), '前提：A/B 必须近重复，否则本用例是真空判据')
    const n = appendLessons([
      { title: A, body: 'A 的正文。' },
      { title: B, body: 'B 的补充正文。' },
    ], root)
    const after = fs.readFileSync(file, 'utf8')
    assert.ok(after.includes('A 的正文。'), `A 正文必须在磁盘上，实际:\n${after}`)
    assert.ok(after.includes('B 的补充正文。'), `B 正文必须在磁盘上（旧实现会静默丢弃），实际:\n${after}`)
    assert.equal(n, 2, `返回值必须等于实际处理的条目数，实际：${n}`)
    const heads = after.split(NL).filter(l => l.startsWith('## '))
    assert.equal(heads.length, 1, `B 应并入 A，只落一个 ## 块，实际：${heads.join(' | ')}`)
  })
})

// [lesson-merge-append-v1] 并入既有条目时，补充段必须**追加在正文之后**，
//   且前缀只许一个 —— 旧实现把 `补充（…）：` 插到标题正下方，把状态行挤成非首位：
//   `lessons-hygiene` 的「状态行只在标题后首个非空行」当场判红（实测 2026-10-05 现网台账）。
// 承重：① 把写入分支改回 `out.push(...补充)` 在 head 之后 ⇒ 「状态行仍在首位」断言变红；
//   ② 删掉 stripSupplementPrefix 调用 ⇒ 「前缀只出现一次」断言变红。
test('appendLessons: 并入既有条目时状态行仍在首位，且补充前缀只出现一次', () => {
  withTempRoot((root) => {
    const file = path.join(root, '.ai-runner', 'lessons.md')
    const stamp = new Date().toISOString().slice(0, 10)
    const E = 'docs/plan 被 gitignore 但不在 eslint ignores 里'
    const N = 'docs/plan 被 gitignore 但 @antfu/eslint-config 会自动忽略'
    assert.ok(isNearDuplicateTitle(E, N), '前提：E/N 必须近重复，否则本用例是真空判据')
    fs.writeFileSync(file, [
      '# Lessons',
      '',
      `## ${E}`,
      '',
      '[VERIFIED] 2026-10-04 A · 实测忽略规则',
      '',
      '原始正文一句。',
      '',
    ].join(NL), 'utf8')

    // 正文自带同名前缀：旧实现会叠加成 `补充（A）：补充（A）：…`
    const n = appendLessons([{ title: N, body: `补充（${stamp}）：被并入的补充正文。` }], root)
    assert.equal(n, 1, `并入应计 1，实际：${n}`)
    const after = fs.readFileSync(file, 'utf8')
    const lines = after.split(NL)

    // ① 状态行必须在标题后的首个非空行
    const hi = lines.findIndex(l => l.startsWith('## '))
    assert.ok(hi >= 0, `找不到条目标题，实际:\n${after}`)
    const firstNonEmpty = lines.slice(hi + 1).find(l => l.trim() !== '')
    assert.ok(
      String(firstNonEmpty).startsWith('[VERIFIED]'),
      `状态行被挤离首位（lessons-hygiene 会判红），实际首个非空行：${JSON.stringify(firstNonEmpty)}`,
    )

    // ② 补充段追加在正文之后，且前缀唯一
    const pi = lines.findIndex(l => l.includes('被并入的补充正文。'))
    const bi = lines.findIndex(l => l.includes('原始正文一句。'))
    assert.ok(pi > bi, `补充段必须排在既有正文之后，实际 补充@${pi} 正文@${bi}`)
    const marked = lines.filter(l => l.startsWith(`补充（${stamp}）：`)).length
    assert.equal(marked, 1, `补充前缀只允许一个，实际 ${marked} 处:\n${after}`)
    assert.ok(!after.includes(`补充（${stamp}）：补充（${stamp}）：`), `出现双前缀:\n${after}`)
  })
})

// [lesson-merge-append-v1] 同批 nearFresh 路径同样不得叠前缀。
// 承重：删掉 nearFresh 分支里的 stripSupplementPrefix 调用 ⇒ 「双前缀」断言变红
//   （实测 M8：带前缀的必须是**被并入方** B，写成 A 带前缀则判据真空——A 原样写入，压根不走剥离）。
test('appendLessons: 同批 nearFresh 并入时正文自带的前缀不被叠加', () => {
  withTempRoot((root) => {
    const file = path.join(root, '.ai-runner', 'lessons.md')
    const stamp = new Date().toISOString().slice(0, 10)
    fs.writeFileSync(file, `# Lessons${NL}`, 'utf8')
    const A = 'docs/plan 被 gitignore 但不在 eslint ignores 里'
    const B = 'docs/plan 被 gitignore 但 @antfu/eslint-config 会自动忽略'
    assert.ok(isNearDuplicateTitle(A, B), '前提：A/B 必须近重复，否则本用例是真空判据')
    assert.equal(appendLessons([
      { title: A, body: 'A 的正文。' },
      { title: B, body: `补充（${stamp}）：B 的正文。` },
    ], root), 2)
    const after = fs.readFileSync(file, 'utf8')
    assert.ok(!after.includes(`补充（${stamp}）：补充（${stamp}）：`), `出现双前缀:\n${after}`)
    assert.ok(after.includes('A 的正文。') && after.includes('B 的正文。'), `两条正文都必须在磁盘上:\n${after}`)
    // A 原样写入（无前缀），B 由写入层加一个前缀 ⇒ 恰好 1 处带前缀的行
    const marked = after.split(NL).filter(l => l.startsWith(`补充（${stamp}）：`)).length
    assert.equal(marked, 1, `应恰好 1 处带前缀（B 的），实际 ${marked}:\n${after}`)
  })
})
