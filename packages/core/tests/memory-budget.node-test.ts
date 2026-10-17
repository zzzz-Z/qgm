// [memory-budget-v2] 注入型记忆文件的预算守卫。
// [memory-budget-external-skip-v1] 被测文件 `.workbuddy/memory/MEMORY.md` 属另一个工具（CodeBuddy）的
//   运行态资产，**不在本仓 git 内**：CI、新 clone、未装该工具的机器上它必然不存在。
//   原实现 `expect(raw).not.toBeNull()` 会让这类环境恒红 —— 那不是「发现回归」，是「缺对象」。
//   故改为：文件存在时全量校验（体积 ratchet + 冻结标识符 + 令牌数，判据一字不减）；
//   不存在时整组 skip 并给出显式原因。**不是降格为警告**：有对象时判据仍然承重。
// [memory-budget-v1] 注入型记忆文件的预算守卫。
// WHY: `.workbuddy/memory/MEMORY.md` 每一轮都被注入提示词 ⇒ 体积直接换成每轮成本；
//   但它同时是「不看就会出错」的铁律唯一载体 ⇒ 删错一条比多花几千 token 贵得多。
//   无闸门时它会静默回涨：实测 2026-10-04 压到 3520 字符，2026-10-05 已回涨到 4670（+33%，
//   一天之内，无任何信号）。故本守卫只做两件事：卡住体积，以及卡住「靠删标识符达成的假压缩」。
// CHANGE-IMPACT: 字符上限是 ratchet——收紧只会让后续新增更难通过，不会让既有内容变红。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const FILE = path.join(ROOT, '.workbuddy', 'memory', 'MEMORY.md')
const NL = String.fromCharCode(10)

// [阈值依据 2026-10-05] 实测拆解：全文字符 4275，其中行内代码令牌占 1977（46.2%），
//   非代码部分（标题/节名/空行/项目符号/散文）2249 ⇒ 摊到 34 条铁律只剩 62 字符散文/条。
//   要压到项目历史基线 3520 需 45 字符/条、压到通用预算 3000 需 30 字符/条（约 10 个汉字），
//   那不是压缩而是删规则 ⇒ 取 4300 作为 ratchet：贴住当前实测下限，仅拦截后续回涨。
//   [CONSTRAINT] 断言用字面量而非导出常量——否则「改常量 → 期望值同步变 → 永不红」。
const MAX_CHARS = 4300
const MAX_LINES = 60
const MIN_RULES = 30
const MIN_CODE_TOKENS = 115

/**
 * [CONSTRAINT] 冻结清单：这些是「删了再也推不出来」的唯一标识符（环境变量名、脚本名、
 * 错误码、守卫文件名、字段名）。压缩时砍散文可以，砍它们不行——
 * 所以这里做的是存在性断言，而不是长度断言。
 */
const FROZEN_TOKENS = [
  'CODEBUDDY_SAFE_DELETE_ENABLED=0',
  'curl -sS --noproxy \'*\'',
  'includes(\'× \')',
  'Test Files  1 failed',
  'setRoot(tmp)',
  'getRoot()',
  'mtimeMs',
  'T_TOTAL=',
  '5s<12s',
  'test:tsc',
  'anchors.json',
  'session:start',
  'ai-guard.node-test.ts',
  'SHELL_METACHAR_UNSUPPORTED',
  'ANCHOR_TOO_SHORT',
  'nearLines',
  '{ok:false}',
  'auto-imports.d.ts',
  'page.evaluate',
  'TS2393',
  '[selfcheck-subset-v1]',
  'EADDRINUSE',
  '/assets/*.js',
  'replLoop',
  'applyOverlay',
  'scriptOk',
  'copy-runtime.cjs',
  'runtime-cjs-copy.node-test.ts',
  'NATIVE_API_FORBIDDEN',
  'step 2.5 synced',
  'restart*.log',
  'exists/listDir/readText',
  'lessons-status.cjs',
  'lessons-hygiene.node-test.ts',
  '[REJECTED]',
  'tasksBySid[sid].items',
  'todoItems',
  'reply-mark-parity',
  'markedNonScript',
  'docs/plan/skill-autoload-loop-guard.md',
  'C-contract-drift.*',
  'COPY . .',
  'pre/<runId>',
]

const raw = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : null
const lines = String(raw || '').replace(/\r\n/g, NL).split(NL)
const rules = lines.filter(l => l.startsWith('- '))
const codeTokens = String(raw || '').match(/`[^`\n]*`/g) || []

const MISSING = raw === null
// [memory-budget-external-skip-v1] 缺失即跳过整组：没有对象可校验，判 fail 只会掩盖真回归
describe.skipIf(MISSING)('MEMORY.md 注入预算', () => {
  it('结构可解析（分节 + 铁律条目）', () => {
    expect(lines.filter(l => l.startsWith('## ')).length).toBeGreaterThanOrEqual(3)
    expect(rules.length).toBeGreaterThanOrEqual(MIN_RULES)
  })

  it(`字符数 ≤ ${MAX_CHARS} 且行数 ≤ ${MAX_LINES}（ratchet，不得静默回涨）`, () => {
    const chars = [...String(raw || '')].length
    expect(
      chars,
      `MEMORY.md 已 ${chars} 字符 / ${lines.length} 行，超 ratchet ${MAX_CHARS}。`
      + `${NL}加压前先读本文件头的阈值依据：纯压缩已到密度下限（代码令牌占 46%），`
      + `${NL}继续压只能靠结构拆分（详情外移到按主题的档案文件 + 主文件留指针）——那是设计变更，`
      + `${NL}不要靠调大这个数字「修复」。`,
    ).toBeLessThanOrEqual(MAX_CHARS)
    expect(lines.length).toBeLessThanOrEqual(MAX_LINES)
  })

  it('关键标识符未被压缩掉（防「删标识符式假压缩」）', () => {
    const text = String(raw || '')
    const missing = FROZEN_TOKENS.filter(t => !text.includes(t))
    expect(
      missing,
      `以下唯一标识符已从 MEMORY.md 消失，读者再也推不出来：${NL}${missing.map(t => `  - ${t}`).join(NL)}`,
    ).toEqual([])
  })

  it(`行内代码令牌数 ≥ ${MIN_CODE_TOKENS}（防整体令牌流失）`, () => {
    expect(codeTokens.length).toBeGreaterThanOrEqual(MIN_CODE_TOKENS)
  })
})
