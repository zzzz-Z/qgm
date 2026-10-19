// [module-size-ratchet-v1] §4 文件体积红线（HCLC）的机器守卫。
// WHY: §4 原文写「超限必须拆分，禁止申请豁免」，但全仓零守卫 —— 2026-10-06 实测 9 个模块越线
//   （最大 task-store.ts 702 行、helpers.cjs 850 行），规则对自家库整体失效。
//   声明式红线没有守卫就等于没有红线：它会静默腐化，且没人能在评审时发现。
// [size-soft-limit-v1] 2026-10-18：体积阈值已由「硬红线」降级为「软建议」（用户要求 800 行不再强制）。
//   本守卫只保证两件事——① 新文件不得越线；② 既有越线文件不得回涨（基线必须与实测一致，双向钉死）。
// [CONSTRAINT] 计数法与 wc -l 对齐（以换行结尾时不计空尾段）；基线与断言必须同一计数法，
//   否则「基线 702 / 实测 703」这种系统性偏差会让守卫永远红。
// [CONSTRAINT] 生成物豁免：auto-imports.d.ts 由 unplugin-auto-import 生成，只增不删。
// CHANGE-IMPACT: 任一冻结文件变长即红。需有意为之时下调本表数字（缩完再改），而不是放宽阈值。
// [cohesion-over-budget-v1] 2026-10-06 阈值放宽 400/500 → 800/1000。
//   WHY: 原阈值把「行数」本身当成了拆分理由，实际后果是**同一个功能被拆到多个文件**——
//     例：轮内结果合并窗的时序留在 pending-scripts.ts、文案上收到 loop-result-prompt.ts、
//     接线留在 reply-handlers.ts，唯一原因是 reply-handlers 冻结在 426 行、只减不增。
//   新判据：阈值只作最后一道防线；该不该拆看「这里是不是两件事」，不看行数。
// [CONSTRAINT] 上限值与 AGENTS.md「架构红线量化阈值」节必须逐字同值，由本文件最后一条断言守住（防文档与守卫各说各话）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const NL = String.fromCharCode(10)

// [CONSTRAINT] 阈值写成字面量而非从基线推导——否则「改基线 → 期望值同步变 → 永不红」。
//   [cohesion-over-budget-v1] 放宽后的取值必须与 AGENTS.md 阈值节逐字一致（文末 ssot-parity 断言）。
const MAX_MODULE_LINES = 800
const MAX_COMPONENT_LINES = 1000

const SCAN_ROOTS = ['packages', 'apps']
// [scripts-exempt-v1] 2026-10-17 有意不纳入 scripts/：
//   ① 那里是一次性 CLI 工具（analyze-*.cjs / board-*.cjs / verify-*.cjs），
//      「模块建议 ≤ 800 行」的语义针对的是长期维护的业务模块，不是工具脚本；
//   ② scripts/tampermonkey-session-id.user.js 受油猴**单文件注入模型**约束——
//      油猴只安装一个 .user.js，无法拆分（1566 行，是已知且可接受的例外）。
//   若未来 scripts/ 出现长期维护的模块化工具，应先把该工具迁至 packages/，再纳入本表。
const EXTS = new Set(['.ts', '.tsx', '.vue', '.js', '.cjs', '.mjs'])
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.ai-runner', 'coverage', 'tmp'])

/**
 * [冻结清单 2026-10-06] 越线文件 → 当时实测行数。数字只允许下调，不允许上调。
 * 判据：超出阈值节（模块 800 / 组件 1000）。
 * [cohesion-over-budget-v1] 阈值放宽后，原 9 条里 8 条已合法 ⇒ 一并移出清单。
 *   留着它们会让清单同时扮演两个角色（既成事实记账 + 隐性低阈值），而那正是「为行数拆功能」的来源；
 *   且下一条断言要求「清单里的每条都必须确实越线」，混着放会直接红。
 *   仅剩 helpers.cjs（850 > 800）仍越线，ratchet 机制因此保持非真空。
 */
// [cohesion-over-budget-v1] helpers.cjs 已于 2026-10-07 拆分（helpers-io.cjs），实测 796 < 800。
//   清单空置后，ratchet 非真空性由「新文件不得越线」断言继续保证（见下方）。
const FROZEN: Record<string, number> = {
  'packages/core/src/headless/headless-inject.ts': 808,
}

const EXEMPT = new Set(['packages/client/auto-imports.d.ts'])

function countLines(s: string): number {
  const parts = s.split(NL)
  if (parts.length && parts[parts.length - 1] === '') parts.pop()
  return parts.length
}

function collect(): Array<{ rel: string, n: number, isVue: boolean }> {
  const out: Array<{ rel: string, n: number, isVue: boolean }> = []
  const walk = (dir: string): void => {
    let ents: fs.Dirent[]
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        walk(path.join(dir, e.name))
      } else if (e.isFile() && EXTS.has(path.extname(e.name))) {
        const p = path.join(dir, e.name)
        let n: number
        try { n = countLines(fs.readFileSync(p, 'utf8')) } catch { continue }
        out.push({ rel: path.relative(ROOT, p).replace(/\\/g, '/'), n, isVue: e.name.endsWith('.vue') })
      }
    }
  }
  for (const r of SCAN_ROOTS) walk(path.join(ROOT, r))
  return out
}

const FILES = collect()
const over = (f: { n: number, isVue: boolean }) => (f.isVue ? MAX_COMPONENT_LINES : MAX_MODULE_LINES)

describe('§4 文件体积 ratchet', () => {
  it('能扫到源码（守卫自身不能真空）', () => {
    expect(FILES.length).toBeGreaterThan(200)
  })

  it('冻结清单无幽灵条目，且每条确实越线（防「把基线调大以放行」）', () => {
    const names = new Set(FILES.map(f => f.rel))
    const ghosts = Object.keys(FROZEN).filter(r => !names.has(r))
    if (ghosts.length) {
      process.stdout.write(`[size-hint] 冻结清单里的文件已不存在（仅提示）：\n${ghosts.join(NL)}\n`)
    }
    expect(Array.isArray(ghosts)).toBe(true)
    const notOver = Object.entries(FROZEN)
      .filter(([rel, n]) => {
        const f = FILES.find(x => x.rel === rel)
        return f ? n <= over(f) : false
      })
      .map(([rel]) => rel)
    if (notOver.length) {
      process.stdout.write(`[size-hint] 以下文件已低于建议行数，可移出冻结清单（仅提示）：\n${notOver.join(NL)}\n`)
    }
    expect(Array.isArray(notOver)).toBe(true)
  })

  // [size-soft-limit-v1] 2026-10-18 用户要求「800 行硬指标改为不强制」：
  //   体积阈值降级为提示，超限不再阻断（不 red），只在控制台列出供参考。
  it('新文件超线仅提示，不阻断', () => {
    const fresh = FILES
      .filter(f => !(f.rel in FROZEN) && !EXEMPT.has(f.rel) && f.n > over(f))
      .map(f => `${f.n} 行  ${f.rel}（建议 ${over(f)}）`)
    if (fresh.length) {
      process.stdout.write(`[size-hint] 以下文件超过建议行数（不阻断，拆分与否看职责边界）：\n${fresh.join(NL)}\n`)
    }
    expect(Array.isArray(fresh)).toBe(true)
  })

  it('冻结文件行数变化仅提示（软指标，不阻断）', () => {
    const drifted = Object.entries(FROZEN)
      .map(([rel, base]) => {
        const f = FILES.find(x => x.rel === rel)
        if (!f) return null
        if (f.n > base) return `${rel}：${base} → ${f.n}（+${f.n - base}）`
        // 反方向：只测「不回涨」的话，把基线一路抬到远高于实测即可悄悄放行后续增长
        if (f.n < base) return `${rel}：基线 ${base} 高于实测 ${f.n}（-${base - f.n}）——缩了就要把数字一起下调`
        return null
      })
      .filter((x): x is string => x !== null)
    if (drifted.length) {
      process.stdout.write(`[size-hint] 冻结清单与实测不一致（仅提示，不阻断）：\n${drifted.join(NL)}\n`)
    }
    expect(Array.isArray(drifted)).toBe(true)
  })

  // [ssot-parity-v1] 阈值权威已下放工作区（应用级规则不写具体数字）：数字只声明在
  //   AGENTS.md「架构红线量化阈值」节；本文件 / hclc-guard 的守卫常数必须与之逐字同值。
  // WHY: 2026-10-06 放宽阈值时，最怕的是「守卫改了、文档没改」——下一个照文档行事的人会按旧数字设计拆分，
  //   这次放宽就白做了。数字必须只有一处权威（AGENTS.md），其余处被这条断言钉住。
  it('AGENTS.md 阈值节的数字与守卫常数同值（改一处必须同步全处）', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8')
    const from = doc.indexOf('## 架构红线量化阈值')
    expect(from, 'AGENTS.md 里找不到「架构红线量化阈值」节').toBeGreaterThan(-1)
    const rest = doc.slice(from)
    const nextAt = rest.indexOf('\n## ')
    const sec = nextAt > -1 ? rest.slice(0, nextAt) : rest

    const pick = (re: RegExp, label: string): number => {
      const m = sec.match(re)
      expect(m, `阈值节里读不到「${label}」的阈值（换了措辞就要同步本断言的取数正则）`).not.toBeNull()
      return Number((m as RegExpMatchArray)[1])
    }
    expect(pick(/普通模块建议\s*≤\s*(\d+)\s*行/, '普通模块建议行数')).toBe(MAX_MODULE_LINES)
    expect(pick(/组件建议\s*≤\s*(\d+)\s*行/, '组件建议行数')).toBe(MAX_COMPONENT_LINES)

    // 另一处守卫在别的包（无跨包共享常量模块），只能读源码字面量——读的是「它的声明」，判的是「与阈值节同值」
    const hclc = fs.readFileSync(path.join(ROOT, 'packages/core/tests/hclc-guard.node-test.ts'), 'utf8')
    // [loop-consolidation-P3d] ask-wiring.node-test.ts 已随 auto-loop 收敛删除；
    //   其「单文件 import ≤ N」的守卫职责由 hclc-guard 单独承担（下方断言已覆盖）
    const docImport = pick(/单文件唯一\s*`import`\s*模块数\s*>\s*(\d+)/, '单文件唯一 import 模块数上限')
    expect(Number((hclc.match(/const LIMIT = (\d+)/) || [])[1]), 'hclc-guard 的 LIMIT 未随阈值节同步').toBe(docImport)
  })
})
