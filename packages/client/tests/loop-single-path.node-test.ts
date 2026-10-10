// [loop-single-path-v1] 承重判据：应用内只应存在一条「执行-回传」路径（循环外那条）。
// [WHY] 计划 docs/plan/loop-consolidation.md 段五 P0 —— 删 auto-loop 子系统前先钉死
//   「启动族零调用点」；P2/P3 删代码时若误留消费方，本判据会精确变红。
// [扫描面自陈] 本判据的扫描面是**字面量标识符**（源码文本），不含动态调用形态
//   （属性访问 api.startLoop() / bracket 索引 api['startLoop']() / eval）。
//   动态形态由 test ③ 单独覆盖（属性调用 + bracket 索引两类）。
//   **已知盲区**：`const { startLoop } = useAutoLoop()` 这类解构赋值本判据抓不到 ——
//   但若解构后调用，test ② 的字面量扫描会命中调用点；不调用则无危害。
// [阶段感知] phase() = 'A' | 'B'，切换点在 P3e（与删文件同一次提交）：
//   A（P0–P2 期间）：定义 === 2 && 调用 === 0
//   B（P3 删文件之后）：start-family.ts 不存在 && auto-loop/ 目录不存在
// [变异验证] V0 基线 PASS / V2 注入调用 FAIL / V3 正则失效 FAIL —— 见计划段八 D2。
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// [阶段切换点] P3e 只改这一行（'A' → 'B'），与删文件同一次提交
// [loop-consolidation-P3e] 阶段切换：A → B（P3b 已删 auto-loop/ 整目录 + 3 文件）。
//   阶段 B 判据：start-family.ts 不存在 && auto-loop/ 目录不存在 && 调用 === 0。
const PHASE_VALUE: 'A' | 'B' = 'B'
/** 经函数读取而非直读常量：TS 控制流分析会把 const 字面量收窄，使 `PHASE === 'B'` 判为无重叠（TS2367） */
function phase(): 'A' | 'B' { return PHASE_VALUE }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const CLIENT = path.join(ROOT, 'packages', 'client')
const AUTO_LOOP = path.join(CLIENT, 'composables', 'ai', 'auto-loop')
const START_FAMILY = path.join(AUTO_LOOP, 'start-family.ts')

/** 递归收集 .ts/.vue 源文件（排除 tests / dist / 生成物） */
function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return out }
  for (const e of entries) {
    if (e === 'node_modules' || e === 'dist' || e === '.git' || e === '.ai-runner' || e === 'tests') continue
    const p = path.join(dir, e)
    let isDir = false
    // [why-not-length] 原写法 `readdirSync(p).length >= 0` 恒为真，靠 catch 兜住文件情形——
    //   行为碰巧正确但判据误导；改为显式 statSync().isDirectory()
    try { isDir = statSync(p).isDirectory() } catch { isDir = false }
    if (isDir) { walk(p, out); continue }
    if (!/\.(?:ts|vue)$/.test(e)) continue
    if (/\.d\.ts$/.test(e)) continue
    out.push(p)
  }
  return out
}

/** 读入全部源文件（读失败按空串处理，不阻断判据） */
function readAll(files: string[]): Array<{ f: string, text: string }> {
  return files.map((p) => {
    let text = ''
    try { text = readFileSync(p, 'utf8') } catch { text = '' }
    return { f: p, text }
  })
}

describe('[loop-single-path-v1] 启动族收敛判据', () => {
  const sources = readAll(walk(CLIENT))

  it('① 扫描器自证：定义数 === 2（阶段 A）', () => {
    if (phase() === 'B') {
      expect(existsSync(START_FAMILY)).toBe(false)
      expect(existsSync(AUTO_LOOP)).toBe(false)
      return
    }
    const re = /^\s*(?:export\s+)?async\s+function\s+(?:startLoop|startTakeover)\s*\(/gm
    let n = 0
    for (const { text } of sources) {
      const m = text.match(re)
      if (m) n += m.length
    }
    // [WHY] 「定义 === 2」是「扫描器确实在工作」的自证：
    //   正则失效 / 文件集为空 ⇒ 定义 0 ⇒ 本断言 FAIL（拒绝真空通过）
    expect(n).toBe(2)
  })

  it('② 零调用点（阶段 A）', () => {
    if (phase() === 'B') {
      expect(existsSync(START_FAMILY)).toBe(false)
      return
    }
    const callRe = /(?<![.\w])(?:startLoop|startTakeover)\s*\(/
    const defRe = /(?:function\s+|const\s+)(?:startLoop|startTakeover)\b/
    const offenders: string[] = []
    for (const { f, text } of sources) {
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const L = lines[i]
        if (!/startLoop|startTakeover/.test(L)) continue
        if (/^\s*\/\//.test(L)) continue
        if (defRe.test(L)) continue
        if (callRe.test(L)) offenders.push(`${f.replace(ROOT, '')}:${i + 1}: ${L.trim().slice(0, 120)}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('③ 无动态访问形态（属性调用 / bracket 索引）', () => {
    const offenders: string[] = []
    for (const { f, text } of sources) {
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const L = lines[i]
        if (/^\s*\/\//.test(L)) continue
        if (/\.(?:startLoop|startTakeover)\s*\(/.test(L)) {
          offenders.push(`${f.replace(ROOT, '')}:${i + 1} [属性调用] ${L.trim().slice(0, 100)}`)
        }
        if (/\[\s*['"](?:startLoop|startTakeover)['"]\s*\]/.test(L)) {
          offenders.push(`${f.replace(ROOT, '')}:${i + 1} [bracket 索引] ${L.trim().slice(0, 100)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
