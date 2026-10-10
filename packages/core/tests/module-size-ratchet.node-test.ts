// [module-size-ratchet-v1] §4 文件体积红线（HCLC）的机器守卫。
// WHY: §4 原文写「超限必须拆分，禁止申请豁免」，但全仓零守卫 —— 2026-10-06 实测 9 个模块越线
//   （最大 task-store.ts 702 行、helpers.cjs 850 行），规则对自家库整体失效。
//   声明式红线没有守卫就等于没有红线：它会静默腐化，且没人能在评审时发现。
// [CONSTRAINT] 只做 ratchet，不做一次性清理：越线文件是既成事实，强制清零会阻塞无关改动。
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
// [CONSTRAINT] 上限值与 SYSTEM.md §4 必须逐字同值，由本文件最后一条断言守住（防文档与守卫各说各话）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const NL = String.fromCharCode(10)

// [CONSTRAINT] 阈值写成字面量而非从基线推导——否则「改基线 → 期望值同步变 → 永不红」。
//   [cohesion-over-budget-v1] 放宽后的取值必须与 SYSTEM.md §4 逐字一致（文末 ssot-parity 断言）。
const MAX_MODULE_LINES = 800
const MAX_COMPONENT_LINES = 1000

const SCAN_ROOTS = ['packages', 'apps']
const EXTS = new Set(['.ts', '.tsx', '.vue', '.js', '.cjs', '.mjs'])
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.ai-runner', 'coverage', 'tmp'])

/**
 * [冻结清单 2026-10-06] 越线文件 → 当时实测行数。数字只允许下调，不允许上调。
 * 判据：超出 §4 阈值（模块 800 / 组件 1000）。
 * [cohesion-over-budget-v1] 阈值放宽后，原 9 条里 8 条已合法 ⇒ 一并移出清单。
 *   留着它们会让清单同时扮演两个角色（既成事实记账 + 隐性低阈值），而那正是「为行数拆功能」的来源；
 *   且下一条断言要求「清单里的每条都必须确实越线」，混着放会直接红。
 *   仅剩 helpers.cjs（850 > 800）仍越线，ratchet 机制因此保持非真空。
 */
// [cohesion-over-budget-v1] helpers.cjs 已于 2026-10-07 拆分（helpers-io.cjs），实测 796 < 800。
//   清单空置后，ratchet 非真空性由「新文件不得越线」断言继续保证（见下方）。
const FROZEN: Record<string, number> = {}

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
    expect(ghosts, `冻结清单里的文件已不存在，清单腐化：${NL}${ghosts.join(NL)}`).toEqual([])
    const notOver = Object.entries(FROZEN)
      .filter(([rel, n]) => {
        const f = FILES.find(x => x.rel === rel)
        return f ? n <= over(f) : false
      })
      .map(([rel]) => rel)
    expect(
      notOver,
      `以下文件已低于 §4 阈值，应移出冻结清单（否则清单会掩盖未来回涨）：${NL}${notOver.join(NL)}`,
    ).toEqual([])
  })

  it('新文件不得越线（未列入冻结清单者）', () => {
    const fresh = FILES
      .filter(f => !(f.rel in FROZEN) && !EXEMPT.has(f.rel) && f.n > over(f))
      .map(f => `${f.n} 行  ${f.rel}（阈值 ${over(f)}）`)
    expect(
      fresh,
      `以下文件超出 §4 体积红线且未在冻结清单中——新代码不得越线，请拆分：${NL}${fresh.join(NL)}`,
    ).toEqual([])
  })

  it('冻结文件不得回涨，基线也不得虚高（ratchet，只减不增）', () => {
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
    expect(
      drifted,
      `冻结基线必须与实测行数一致。§4 的出口是「拆文件」，不是「接着加行」，也不是「把数字改大」：`
      + `${NL}${drifted.join(NL)}${NL}确需增长时先拆分，再把这行数字下调。`,
    ).toEqual([])
  })

  // [ssot-parity-v1] 阈值共声明 4 处：SYSTEM.md §4 / 本文件 / hclc-guard / ask-wiring。
  // WHY: 2026-10-06 放宽阈值时，最怕的是「守卫改了、文档没改」——下一个照文档行事的人会按旧数字设计拆分，
  //   这次放宽就白做了。数字必须只有一处权威（§4），其余三处被这条断言钉住。
  it('SYSTEM.md §4 的阈值与三处守卫常数同值（改一处必须同步全处）', () => {
    const md = fs.readFileSync(path.join(ROOT, 'packages/core/SYSTEM.md'), 'utf8')
    const from = md.indexOf('## §4')
    const to = md.indexOf('## §5')
    expect(from, 'SYSTEM.md 里找不到 §4 段落').toBeGreaterThan(-1)
    expect(to, 'SYSTEM.md 里找不到 §5 段落（§4 的截断锚点）').toBeGreaterThan(from)
    const sec = md.slice(from, to)

    const pick = (re: RegExp, label: string): number => {
      const m = sec.match(re)
      expect(m, `§4 里读不到「${label}」的阈值（换了措辞就要同步本断言的取数正则）`).not.toBeNull()
      return Number((m as RegExpMatchArray)[1])
    }
    expect(pick(/普通模块\s*≤\s*(\d+)\s*行/, '普通模块行数上限')).toBe(MAX_MODULE_LINES)
    expect(pick(/组件\s*≤\s*(\d+)\s*行/, '组件行数上限')).toBe(MAX_COMPONENT_LINES)

    // 另两处守卫在别的包（无跨包共享常量模块），只能读源码字面量——读的是「它的声明」，判的是「与 §4 同值」
    const hclc = fs.readFileSync(path.join(ROOT, 'packages/core/tests/hclc-guard.node-test.ts'), 'utf8')
    // [loop-consolidation-P3d] ask-wiring.node-test.ts 已随 auto-loop 收敛删除；
    //   其「单文件 import ≤ N」的守卫职责由 hclc-guard 单独承担（下方断言已覆盖）
    const docImport = pick(/单文件唯一\s*`import`\s*模块数\s*>\s*(\d+)/, '单文件唯一 import 模块数上限')
    expect(Number((hclc.match(/const LIMIT = (\d+)/) || [])[1]), 'hclc-guard 的 LIMIT 未随 §4 同步').toBe(docImport)
  })
})
