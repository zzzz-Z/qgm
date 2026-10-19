// [script-card-head-v2] ScriptCard 头部信息架构守卫。
// [WHY] 2026-10-09 复核：卡片头部只放 desc，而「这一步为什么做」的 why 与「失败原因」reason
//   都藏在展开区里 ⇒ 想理解某一行必须逐行点开；且 hasBody 含 why 使**几乎每张卡**都长出
//   ▸ 折叠箭头，点开大多只有一段复述 + 无信息量的输出尾行。
//   这类「信息放错层级」不会让任何现有测试变红（结构仍在、渲染仍正常），必须显式守卫：
//   ① hasBody 是否又把 why 算进去（箭头泛滥回归）；
//   ② why / reason 是否又被打回展开区（层级回归）；
//   ③ 单行省略的单行文本是否还带溢出提示（截断后无法查看全文回归）。
// [CONSTRAINT] 判据必须落在 <template> 段与规则体上，不能拿「整个文件里出现过某字符串」来判 ——
//   注释里就会提及 why / 旧类名，那样的判据恒真。
// [CHANGE-IMPACT] 改 ScriptCard 头部结构而不改本文件 ⇒ 本文件变红（强制两边同步）。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const CARD = 'packages/client/components/script/ScriptCard.vue'
const PANE = 'packages/client/components/script/TerminalPane.vue'
const BUILD = 'packages/client/utils/timeline-build.ts'
const MAIN = 'packages/client/main.ts'
const DIRECTIVE = 'packages/client/directive.ts'

const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8')

/** 取 <template> 段：剥掉 <style> 里的同名类名与注释，避免「整文件包含」式假判据 */
function templateOf(vue: string): string {
  const m = vue.match(/<template>([\s\S]*)<\/template>/)
  assert.ok(m, '未找到 <template> 段')
  return m[1]
}

/**
 * 取某条 CSS 规则的规则体（从 `sel {` 到首个 `}`）。
 * [WHY 必须锚定行首裸选择器] 后代选择器（`.script-card-l1 > .script-card-desc {`）里也含子串
 *   `.script-card-desc {`：裸 indexOf 会先命中它（body 只有 flex），让判据对着错误的规则断言
 *   —— 实测 desc 规则明明有 nowrap 仍被判红（2026-10-19 复核）。
 */
function ruleBody(css: string, sel: string): string {
  const at = css.indexOf(`\n${sel} {`)
  assert.ok(at >= 0, `样式里找不到行首裸选择器规则 ${sel}`)
  const end = css.indexOf('}', at)
  assert.ok(end > at, `规则 ${sel} 未闭合`)
  return css.slice(at, end)
}

/** 头部区块：从 .script-card-head 起、到 .script-card-tail 止（同时锚定两者前后顺序） */
function headBlock(tpl: string): string {
  const at = tpl.indexOf('class="script-card-head"')
  assert.ok(at >= 0, '模板里找不到 .script-card-head')
  const end = tpl.indexOf('class="script-card-tail"', at)
  assert.ok(end > at, '模板里 .script-card-tail 不在 .script-card-head 之后（展开区的锚点已失配）')
  return tpl.slice(at, end)
}

const CARD_SRC = read(CARD)
const CARD_TPL = templateOf(CARD_SRC)
const HEAD = headBlock(CARD_TPL)
const TAIL = CARD_TPL.slice(CARD_TPL.indexOf('class="script-card-tail"'))

// ---------- ① 展开箭头的出现条件 ----------

test('hasBody 只看原始输出，不再含 why（含 why ⇒ 无输出步骤也长折叠箭头）', () => {
  const m = CARD_SRC.match(/const hasBody = computed\(\(\) =>([\s\S]*?)\)\n/)
  assert.ok(m, '未找到 hasBody 定义（表达式形态变更后需同步本判据）')
  const expr = m[1]
  assert.ok(!/\bwhy\b/.test(expr), `hasBody 又包含 why ⇒ 折叠箭头泛滥回归。实际表达式：${expr.trim()}`)
  assert.match(expr, /changes/, 'hasBody 应包含 changes（否则有变更的步骤点不开）')
  assert.match(expr, /stderrText/, 'hasBody 应包含 stderrText（否则失败输出点不开）')
})

test('展开控件（class/role/tabindex/aria/click）仍由 hasBody 统一驱动', () => {
  // 反向保障：若有人把 hasBody 从模板里摘掉、改成无条件可点，上一条判据会被绕过
  for (const bind of ['\'is-clickable\': hasBody', ':role="hasBody', ':tabindex="hasBody', ':aria-expanded="hasBody']) {
    assert.ok(HEAD.includes(bind), `头部缺绑定 ${bind} ⇒ 展开能力与键盘/无障碍态脱节`)
  }
  assert.match(HEAD, /@click="hasBody \? toggle\(\)/, '头部点击未由 hasBody 门控 ⇒ 无输出的卡也会被点开')
  assert.ok(!/aria-expanded="true"/.test(HEAD), '头部出现硬编码 aria-expanded，应始终由 hasBody 驱动')
})

// ---------- ② 信息层级：why / reason 必须常显在头部 ----------

test('why 常显在头部（回到展开区 ⇒ 又变成「逐行点开才看得懂意图」）', () => {
  assert.match(HEAD, /card\.why/, '头部未渲染 card.why')
  assert.match(HEAD, /class="script-card-why"/, '头部缺 .script-card-why 容器')
})

test('展开区只剩原始输出，不得再渲染 why（与头部重复 = 双源）', () => {
  assert.ok(!/card\.why/.test(TAIL), '展开区又渲染 why ⇒ 与头部常显的 why 重复')
  assert.match(TAIL, /card\.changes/, '展开区丢了变更文件列表渲染')
  assert.match(TAIL, /card\.stderrText/, '展开区丢了 stderr 渲染')
})

test('失败原因常显在头部（藏进折叠区 ⇒ 失败时先点开才知道要不要点开）', () => {
  assert.match(HEAD, /card\.reason/, '头部未渲染 card.reason')
  assert.match(HEAD, /class="script-card-reason"/, '头部缺 .script-card-reason 容器')
  assert.ok(!/card\.reason/.test(TAIL), '失败原因不该同时出现在展开区（双源）')
})

// ---------- ②b 三级层级：L1 常显 / L2 折叠 / L3 按需 ----------

test('[script-card-l3-v1] why/reason 被 L2 折叠区门控（否则等于回到「全平铺」）', () => {
  assert.match(HEAD, /class="script-card-l2"/, '头部缺 L2 容器 .script-card-l2')
  const l2 = HEAD.slice(HEAD.indexOf('class="script-card-l2"'))
  const l2End = l2.indexOf('</span>')
  const l2Block = l2.slice(0, l2End)
  assert.match(l2Block, /card\.why/, 'L2 里应有 why')
  // 门控必须存在：v-if="expanded && hasL2"
  assert.ok(
    /v-if="expanded && hasL2"/.test(HEAD),
    'L2 未受 expanded 门控 ⇒ 折叠层级形同虚设（why/reason 又变常显）',
  )
})

test('[script-card-l3-v1] hasL2 计算属性存在且不引用 hasBody', () => {
  const m = CARD_SRC.match(/const hasL2 = computed\(\(\) =>([\s\S]*?)\)\n/)
  assert.ok(m, '未找到 hasL2 定义')
  assert.match(m[1], /why/, 'hasL2 应包含 why')
  assert.match(m[1], /reason/, 'hasL2 应包含 reason')
})

// ---------- ③ 溢出提示：单行省略必须配 tooltip ----------

test('desc / why / reason 三处单行文本都挂了溢出提示指令', () => {
  for (const field of ['desc', 'why', 'reason']) {
    assert.ok(
      HEAD.includes(`v-overflow-tip="card.${field}"`),
      `card.${field} 缺 v-overflow-tip ⇒ 被省略号裁掉后用户无法查看全文（本仓已有 v-tooltip 是无条件弹出，不适用）`,
    )
  }
})

test('溢出提示的前提成立：desc 仍是单行省略（换成 wrap 后指令永不触发）', () => {
  const style = CARD_SRC.slice(CARD_SRC.indexOf('<style'))
  const desc = ruleBody(style, '.script-card-desc')
  assert.match(desc, /white-space:\s*nowrap/, 'desc 不再是单行 ⇒ 溢出提示失去意义（应同步撤掉该指令）')
  assert.match(desc, /text-overflow:\s*ellipsis/, 'desc 不再省略号截断 ⇒ 截断提示无从谈起')
  assert.match(desc, /min-width:\s*0/, 'desc 缺 min-width:0 ⇒ 列容器下不收缩，省略号不会出现（文本被硬裁）')
})

// ---------- ④ 数据层：reason 必须真的贯通到卡片 ----------

test('reason 贯通：活构建路径 + 同构备份都从 payload 取值并写回卡片对象', () => {
  for (const f of [PANE, BUILD]) {
    const s = read(f)
    assert.match(s, /reason:\s*string/, `${f} 的卡片类型缺 reason 字段`)
    assert.match(s, /p\.reason/, `${f} 未从 payload.reason 取值`)
  }
  // 活构建路径（TerminalPane 的 timelineItems）必须把 reason 放进返回的卡片对象，
  // 否则类型上有、运行时空 —— 头部 v-if 恒假，等于没做。
  assert.match(
    read(PANE),
    /why,\n\s*reason,/,
    `${PANE} 的 run:start 卡片未把 reason 放进返回对象 ⇒ 运行期恒定拿不到（类型通过但头部不显示）`,
  )
  assert.match(read(CARD), /reason:\s*string/, 'ScriptCard 的 CardData 缺 reason ⇒ 模板取到 undefined')
})

// ---------- ⑤ 指令接线 ----------

test('溢出提示指令已定义并注册（未注册时 Vue 只 warn，模板静默失效）', () => {
  assert.match(read(DIRECTIVE), /export const vOverflowTip/, 'directive.ts 未导出 vOverflowTip')
  assert.match(
    read(MAIN),
    /app\.directive\('overflow-tip',\s*vOverflowTip\)/,
    'main.ts 未注册 overflow-tip ⇒ 模板里的 v-overflow-tip 不生效',
  )
})

test('死样式副本：terminal-pane.scss 不得再留同名 .script-card-desc / .why-block', () => {
  const scss = read('packages/client/components/script/terminal-pane.scss')
  for (const sel of ['.script-card-desc', '.why-block', '.script-card-tail']) {
    assert.ok(
      !scss.includes(`${sel} {`),
      `terminal-pane.scss 又出现 ${sel} —— 它以 scoped 挂在 RoundCard/TerminalPane 上，永远打不进 `
      + `ScriptCard 内部元素，只会与 ScriptCard.vue 里的同名规则构成双源（改一处另一处仍满足字符串判据）`,
    )
  }
  // 反向对照：真正被 RoundCard 复用的那条必须留着，防「一刀切删光」
  assert.ok(scss.includes('.script-card-time {'), 'terminal-pane.scss 误删了 RoundCard 仍在用的 .script-card-time')
})

// ---------- ⑥ 完整输出面板：最新卡始终接 liveStdout ----------

test('最新 script 卡始终接 liveStdout，不得以 running 为闸门（跑到终态即退回尾部快照 ⇒ 完整输出缩水）', () => {
  const pane = read(PANE)
  const m = pane.match(/const latestScriptKey = computed\(\(\) =>([\s\S]*?)\n\}\)/)
  assert.ok(m, '未找到 latestScriptKey 定义（改名 / 改形态后需同步本判据）')
  assert.ok(
    !/props\.running/.test(m[1]),
    'latestScriptKey 又以 props.running 为闸门 ⇒ 卡片一进 done 就退回 stdoutText 尾部快照，'
    + '用户跑完瞬间「完整输出面板」缩水成 TAIL 若干行（useRunner 只在下一轮 run() 开头清空 liveStdout）',
  )
  assert.match(
    pane,
    /card\.key === latestScriptKey \? liveStdout : ''/,
    '模板未把 liveStdout 绑到「最新一张」卡 ⇒ 完整输出面板拿不到全量输出',
  )
})
