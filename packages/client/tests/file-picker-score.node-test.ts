// [picker-match-score-v1] @ 选择器的匹配评分守卫。
// [WHY] 原实现只做 `label.includes(q)` 后按「技能全在前、文件全在后」排列，
//   输入 `pb` 匹配不到 `prompt-builder.ts`，且精确命中项可能被 slice(0,200) 截掉。
// [判据承重] 把 scoreMatch 改成恒返回 1 ⇒ 除「空查询」外的所有用例必红。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { it } from 'vitest'

import { dirTail, PICKER_MAX_ITEMS, scoreMatch, useFilePicker } from '../components/script/file-picker.js'

const ROOT = process.cwd()

const DEEP = 'packages/client/components/script/prompt-builder.ts'

it('scoreMatch：空查询返回 1（全部保留，不参与排序区分）', () => {
  assert.equal(scoreMatch(DEEP, ''), 1)
})

it('scoreMatch：完全不匹配返回 0', () => {
  assert.equal(scoreMatch(DEEP, 'zzzz-not-exist'), 0)
})

it('scoreMatch：完全相等 100 > 去扩展名相等 95 > 文件名前缀 90', () => {
  assert.equal(scoreMatch('prompt-builder.ts', 'prompt-builder.ts'), 100)
  assert.equal(scoreMatch(DEEP, 'prompt-builder'), 95, '去 .ts 后与文件名相等')
  assert.equal(scoreMatch(DEEP, 'prompt'), 90, '文件名前缀')
  assert.ok(scoreMatch(DEEP, 'prompt-builder.ts') > scoreMatch(DEEP, 'prompt'))
})

it('scoreMatch：任意路径段首 80，且高于纯子串 50', () => {
  assert.equal(scoreMatch(DEEP, 'script'), 80, '路径段 script 的段首匹配')
  assert.equal(scoreMatch('abcdef', 'cde'), 50, '中段子串')
  // [CONSTRAINT] 同为路径段首时评分相同（都是 80）——scoreMatch 不含「段位置敏感」，
  //   因为它对 @ 选择器没有可论证的收益：输入 script 时 prompt-builder.ts 与
  //   script.ts 谁更该排前，取决于用户意图而非路径深度。
  assert.equal(scoreMatch(DEEP, 'script'), scoreMatch(DEEP, 'components'), '不同段首同分')
})

it('scoreMatch：词首缩写能命中（pb → Prompt-Builder），评分 40', () => {
  // 这是原实现完全缺失的能力：`includes('pb')` 对 prompt-builder.ts 返回 false
  assert.equal(scoreMatch(DEEP, 'pb'), 40)
  assert.equal(scoreMatch(DEEP, 'pccspb'), 40, '整条路径的词首缩写')
})

it('scoreMatch：大小写不敏感（两侧都归一化）', () => {
  assert.equal(scoreMatch('Prompt-Builder.ts', 'PROMPT'), 90)
  assert.equal(scoreMatch('PROMPT-BUILDER.TS', 'prompt'), 90)
})

it('scoreMatch：排序语义 —— 精确命中必须排在缩写命中之前', () => {
  const exact = scoreMatch('pb.ts', 'pb')
  const acronym = scoreMatch(DEEP, 'pb')
  assert.ok(exact > acronym, `精确命中(${exact}) 必须高于缩写命中(${acronym})`)
})

// [picker-hover-sync-v1][picker-jump-v1] 交互索引：鼠标悬停同步高亮、Home/End/PageUp/PageDown 跳转。
// [判据承重] 把 pickerSetIndex 的夹紧逻辑删掉 ⇒ T1/T3 必红；把 PAGE 步长改错 ⇒ T3 必红。

/** 构造一个已装载 25 条文件、query 非空的 picker 实例 */
function makePicker() {
  const fp = useFilePicker({ getCmView: () => null })
  fp.pickerFiles.value = Array.from({ length: 25 }, (_, i) => `a${String(i + 1).padStart(2, '0')}.ts`)
  fp.pickerQuery.value = 'a'
  return fp
}

it('pickerSetIndex：索引越界时夹紧到 [0, n-1]，不产生悬空选中', () => {
  const fp = makePicker()
  assert.equal(fp.pickerFiltered.value.length, 25)
  fp.pickerSetIndex(5)
  assert.equal(fp.pickerIndex.value, 5)
  fp.pickerSetIndex(999)
  assert.equal(fp.pickerIndex.value, 24, '上越界夹到末尾')
  fp.pickerSetIndex(-1)
  assert.equal(fp.pickerIndex.value, 0, '下越界夹到开头')
})

it('pickerJump：first / last 直达首尾', () => {
  const fp = makePicker()
  fp.pickerSetIndex(7)
  fp.pickerJump('last')
  assert.equal(fp.pickerIndex.value, 24)
  fp.pickerJump('first')
  assert.equal(fp.pickerIndex.value, 0)
})

it('pickerJump：pageDown / pageUp 步长 10，且在两端夹紧', () => {
  const fp = makePicker()
  fp.pickerJump('pageDown')
  assert.equal(fp.pickerIndex.value, 10)
  fp.pickerJump('pageDown')
  assert.equal(fp.pickerIndex.value, 20)
  fp.pickerJump('pageDown')
  assert.equal(fp.pickerIndex.value, 24, '越过末尾时夹到 24')
  fp.pickerJump('pageUp')
  assert.equal(fp.pickerIndex.value, 14)
})

it('pickerSetIndex / pickerJump：列表为空时静默 no-op（不得抛错、不得改动索引）', () => {
  const fp = makePicker()
  fp.pickerQuery.value = 'zzz-无匹配'
  assert.equal(fp.pickerFiltered.value.length, 0)
  fp.pickerSetIndex(4)
  assert.equal(fp.pickerIndex.value, 0, '空列表不得改变索引')
  fp.pickerJump('last')
  assert.equal(fp.pickerIndex.value, 0)
  fp.pickerJump('pageDown')
  assert.equal(fp.pickerIndex.value, 0)
})

// ============ [picker-full-path-v1] 全路径搜索 ============
// [WHY] 用户 2026-10-21：「可以支持全路径搜索」。旧实现里路径匹配只有 ~30 分（路径段首 80 打 6 折），
//   而同一查询下「文件名中段子串」就有 50 分 —— 结果是被上百条文件名命中压在 200 条截断线之外，
//   体感等于「只能按名搜」。
// [判据承重] 每条都构造了「旧实现必输」的对照：
//   ① 250 条文件名子串命中（50）× 1 条目录命中 → 旧实现在 slice(200) 里把目标切掉；
//   ② 1 条文件名子串命中（50）× 1 条路径段首命中 → 旧实现把 decoy 排前面；
//   ③ 多词查询旧实现整串 includes ⇒ 0 命中。

/** 构造一个装了指定文件列表、query 已就绪的 picker */
function pickerWith(files: string[], query: string) {
  const fp = useFilePicker({ getCmView: () => null })
  fp.pickerFiles.value = files
  fp.pickerQuery.value = query
  return fp
}

const REPO = [
  'packages/client/components/script/RoundCard.vue',
  'packages/client/components/script/file-picker.ts',
  'packages/client/utils/scroll-to.ts',
  'packages/client/composables/ai/useAiWindow.ts',
  'apps/standalone/src/search.vue',
]

it('全路径：目录命中不被 200 条截断饿死（250 条文件名子串命中是旧实现的截断陷阱）', () => {
  // 250 个文件名中段含 utils 的诱饵（label 子串 50 分），加 1 个真正的路径命中
  const decoys = Array.from({ length: 250 }, (_, i) => `packages/x/myutils${String(i).padStart(3, '0')}.ts`)
  const target = 'packages/client/utils/config.ts'
  const fp = pickerWith([...decoys, target], 'utils')
  const picked = fp.pickerFiltered.value.map(i => i.value)
  assert.ok(
    picked.includes(target),
    `路径命中必须留在前 ${PICKER_MAX_ITEMS} 条内（旧实现只有 30 分，被 slice 切掉）`,
  )
  assert.equal(picked[0], target, '目录命中（88）必须排在文件名中段子串（50）之前')
})

it('全路径：路径段首命中优先于文件名中段子串（decoy 必须先输）', () => {
  const fp = pickerWith(['packages/x/myscript.ts', 'packages/client/components/script/RoundCard.vue'], 'script')
  const picked = fp.pickerFiltered.value.map(i => i.value)
  assert.equal(picked[0], 'packages/client/components/script/RoundCard.vue', '旧实现里 myscript.ts（label 子串 50）排在路径命中（80×0.6=48）之前')
})

it('全路径：目录前缀 packages/client 命中整棵子树；段边界 script/file 命中单文件', () => {
  assert.equal(pickerWith(REPO, 'packages/client').pickerFiltered.value.length, 4)
  assert.deepEqual(pickerWith(REPO, 'script/file').pickerFiltered.value.map(i => i.label), ['file-picker.ts'])
})

it('全路径：多词 AND —— client round 只留同时含两词的条目', () => {
  const picked = pickerWith(REPO, 'client round').pickerFiltered.value.map(i => i.value)
  assert.deepEqual(picked, ['packages/client/components/script/RoundCard.vue'])
  assert.equal(pickerWith(REPO, 'client zzz').pickerFiltered.value.length, 0, '任一词不命中即整条不命中')
})

it('全路径：文件名前缀命中仍优先于路径命中（原有排序语义不塌）', () => {
  // scroll-to.ts 同时是文件名前缀（90）与路径段首（88）→ 必须排第一
  const fp = pickerWith([...REPO, 'packages/other/search.vue'], 'scroll')
  assert.equal(fp.pickerFiltered.value.map(i => i.value)[0], 'packages/client/utils/scroll-to.ts')
})

it('全路径：单字符查询不启用路径通道（路径含/以 s 开头的不拽进来）', () => {
  // ① thing.vue 的路径含 s（packages）；② src/ 以 s 开头 ⇒ 旧写法会把整个 src/ 树顶到文件名命中前面
  const files = ['packages/other/thing.vue', 'src/legacy/Thing2.vue', 'packages/client/utils/scroll-to.ts']
  const labels = pickerWith(files, 's').pickerFiltered.value.map(i => i.label)
  assert.ok(!labels.includes('thing.vue'), '单字符启用任意位置子串会让整仓文件都命中，纯噪音')
  assert.ok(!labels.includes('Thing2.vue'), '单字符不得走路径通道：src/ 开头 94 分会把文件名前缀 90 挤下去')
  assert.deepEqual(labels, ['scroll-to.ts'], '文件名前缀 s 必须命中')
})

// [picker-full-path-v1] 行内目录后缀：只在「按路径搜」时出现，普通按名搜的行布局保持单列。
// [判据承重] 把 v-if 的条件放宽成恒显示 ⇒ 第 2 条断言红；把 vite 条件写成恒 false ⇒ 第 1 条红。
it('技能：skill/ 前缀与 skill/<name> 整值都能收窄（占位符明示的前缀不许是死路）', () => {
  // [picker-skill-value-v1] 技能名里没有 `skill/`，title 里是 `skills/`（带 s）⇒ 只查 label/title 时
  //   输入 `skill/` 恒「无匹配」。这条盯的是「按 value 匹配」这一档，删掉即红。
  const fp = useFilePicker({ getCmView: () => null })
  fp.pickerFiles.value = ['packages/client/utils/scroll-to.ts']
  fp.pickerSkills.value = [
    { kind: 'skill', value: 'skill/demo', label: 'demo', hint: '技能 · 演示', dirTail: '', title: 'demo · 演示\n.ai-runner/skills/demo/SKILL.md' },
  ]
  fp.pickerQuery.value = 'skill/'
  assert.deepEqual(fp.pickerFiltered.value.map(i => i.label), ['demo'], 'skill/ 必须能收窄到技能')
  fp.pickerQuery.value = 'skill/demo'
  assert.deepEqual(fp.pickerFiltered.value.map(i => i.label), ['demo'], '整值查询应精确命中')
  fp.pickerQuery.value = 'skill/zzz'
  assert.equal(fp.pickerFiltered.value.length, 0, '不存在的技能名不得命中')
})

it('全路径：行内目录后缀受「查询含 /」与「仅文件」双重门控，且样式可省略收缩', () => {
  const ed = fs.readFileSync(path.join(ROOT, 'packages/client/components/script/ScriptEditor.vue'), 'utf8')
  assert.match(
    ed,
    /<span v-if="it\.kind === 'file' && pickerQuery\.includes\('\/'\)" class="fp-item-dir">\{\{ it\.dirTail \}\}<\/span>/,
    '目录后缀必须由「文件 且 查询含 /」门控——常驻会挤掉文件名（picker-no-inline-hint-v1）',
  )
  const scss = fs.readFileSync(path.join(ROOT, 'packages/client/components/script/script-editor.scss'), 'utf8')
  const block = scss.match(/\.fp-item-dir \{[\s\S]*?\n\}/)?.[0] || ''
  assert.ok(block.includes('text-overflow: ellipsis'), '目录后缀必须单行省略')
  assert.match(block, /max-width: 52%/, '目录后缀必须限宽，否则长路径把文件名挤没')
})

// [picker-dir-left-ellipsis-v1] 目录按「段」保留尾部：差异都在尾部，硬截断会切掉有用信息。
// [判据承重] 把 dirTail 改成恒返回 dir ⇒ 第 2 条断言红；改成保留头段 ⇒ 第 1/2 条红。
it('dirTail：超过阈值只留尾部 N 段并以 …/ 起头，短路径原样返回', () => {
  assert.equal(dirTail('packages/client/components/script'), '…/client/components/script')
  assert.equal(dirTail('apps/standalone/dist/_server', 2), '…/dist/_server')
  assert.equal(dirTail('packages/client/utils'), 'packages/client/utils', '段数不超阈值时不得改动')
  assert.equal(dirTail(''), '')
  // 列表项真的用上了它（而不是把完整目录塞进行内）
  const fp = pickerWith(['packages/client/components/script/RoundCard.vue'], 'components/script')
  assert.equal(fp.pickerFiltered.value[0].dirTail, '…/client/components/script')
})
