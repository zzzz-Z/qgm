// [turn-schema-fingerprint-v1] 「三处同一份源码」的判据。
//
// 为什么需要守卫：无头侧走 page.evaluate（不能 import）、油猴是单文件 IIFE（不能 import）、
//   前端是另一个包 —— 三处都必须是同一份解析器。靠人手复制必然漂移，而漂移的后果是
//   「一方认信封、另一方当噪音」，且不会有一处报错。
//
// 三重断言（缺一不可）：
//   ① 指纹一致：三处产物嵌入的指纹必须相等，且等于**重算的源哈希** —— 防「同步漏跑」；
//   ② 代码体逐字一致：产物抠出的体必须等于 sharedBody(源) —— 防「手改产物」，
//      因为手改不会改它自己头部写的哈希，只比哈希会漏检；
//   ③ 负例：extractBody 对无标记文本必须返回 null —— 防「两边都取到空串」的假通过。
//
// [CONSTRAINT] 守卫与生成器共用 scripts/lib/turn-schema-io.mjs 的**同一套算法**：
//   各写一份规范化/指纹实现，会在去行尾空白/剥 export 的细节上漂移，
//   于是「一致」的断言要么恒真要么永远无法满足（与 tampermonkey-split 同一教训）。

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { beforeAll, describe, expect, test } from 'vitest'

const ROOT = process.cwd()
const SYNC = 'scripts/sync-turn-schema.mjs'

interface Target {
  rel: string
  mode: string
  header: string[]
}

// [CONSTRAINT] 路径相对 tests/ 上溯三层到仓库根；.mjs 无类型声明只能动态解析
// （与 tampermonkey-split.node-test.ts 同款）。
// top-level await 违反 antfu/no-top-level-await（仓库统一禁用）⇒ 放 beforeAll。
let TARGETS: Target[]
let SOURCE_REL: string
let BEGIN: string
let canonicalBody: (src: string) => string
let sharedBody: (src: string, mode: string) => string
let fingerprint: (body: string) => string
let extractBody: (text: string) => null | string
let readFingerprint: (text: string) => string

beforeAll(async () => {
  // @ts-expect-error .mjs 无类型声明，且 scripts/ 不在 tsconfig.test.json 的 include 内
  const mod = await import('../../../scripts/lib/turn-schema-io.mjs')
  TARGETS = mod.TARGETS
  SOURCE_REL = mod.SOURCE_REL
  BEGIN = mod.BEGIN
  canonicalBody = mod.canonicalBody
  sharedBody = mod.sharedBody
  fingerprint = mod.fingerprint
  extractBody = mod.extractBody
  readFingerprint = mod.readFingerprint
})

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

/** 源文件只读一次：所有断言都以它为基准 */
function sourceText(): string {
  return read(SOURCE_REL)
}

/** execFileSync 失败时抛出的对象（Node 未导出该形状的类型名，就地声明） */
interface ExecFailure {
  status?: number
  stdout?: string
  stderr?: string
}

/** 跑 --check（不写盘），返回 { code, out, err } */
function runCheck(): { code: number, err: string, out: string } {
  try {
    const out = execFileSync(process.execPath, [SYNC, '--check'], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
    return { code: 0, out, err: '' }
  }
  catch (e) {
    const fail = e as ExecFailure
    return { code: fail.status ?? 1, out: String(fail.stdout ?? ''), err: String(fail.stderr ?? '') }
  }
}

describe('turn-schema 指纹：三处产物同源', () => {
  test('至少两处已注册产物，且文件都存在（P1 第三片接入无头段后自动纳入）', () => {
    expect(TARGETS.length).toBeGreaterThanOrEqual(2)
    for (const t of TARGETS) {
      expect(existsSync(join(ROOT, t.rel)), `${t.rel} 未生成，请跑 pnpm turn-schema:sync`).toBe(true)
    }
  })

  test('三处产物嵌入的指纹必须相等，且等于重算的源哈希', () => {
    const expectHash = fingerprint(canonicalBody(sourceText()))
    // 负例保护：哈希算法若返回空串/常量，下面的全等断言会假通过
    expect(expectHash, '源哈希必须是 16 位十六进制').toMatch(/^[0-9a-f]{16}$/)
    const embedded = TARGETS.map(t => readFingerprint(read(t.rel)))
    for (const [i, h] of embedded.entries()) {
      expect(h, `${TARGETS[i].rel} 缺 @turn-schema 指纹（未生成或头部被删）`).not.toBe('')
      expect(h, `${TARGETS[i].rel} 指纹与源不一致：改了 ${SOURCE_REL} 却没跑 pnpm turn-schema:sync`).toBe(expectHash)
    }
    expect(new Set(embedded).size, `产物之间指纹分叉：${embedded.join(' / ')}`).toBe(1)
  })

  test('每个产物里指纹注释只出现一次（多处嵌入会让读取取错位置）', () => {
    for (const t of TARGETS) {
      const hits = read(t.rel).match(/@turn-schema:[0-9a-f]{16}/g) ?? []
      expect(hits.length, `${t.rel} 出现 ${hits.length} 处指纹，应恰为 1`).toBe(1)
    }
  })

  test('代码体逐字等于 sharedBody(源)：防手改产物（手改不会改它自己写的哈希）', () => {
    for (const t of TARGETS) {
      const got = extractBody(read(t.rel))
      expect(got, `${t.rel} 缺 BEGIN/END 标记`).not.toBeNull()
      expect(got, `${t.rel} 代码体被手改（与源不一致）`).toBe(sharedBody(sourceText(), t.mode))
    }
  })

  test('外壳适配：module 保留 export，fragment 不得有顶层 export（IIFE 内不合法）', () => {
    const byMode = new Map(TARGETS.map(t => [t.mode, extractBody(read(t.rel)) ?? '']))
    if (byMode.has('module')) {
      expect(byMode.get('module'), 'module 产物必须导出 parseTurn 供前端 import').toContain('export function parseTurn')
    }
    if (byMode.has('fragment')) {
      expect(byMode.get('fragment'), 'fragment 里的 export 会进 IIFE 顶层，直接 SyntaxError').not.toMatch(/^export /m)
    }
  })

  test('负例：无标记文本 extractBody 返回 null，不得返回空串蒙混', () => {
    expect(extractBody('const a = 1\n')).toBeNull()
    expect(extractBody(`${BEGIN}\n`)).toBeNull()
  })

  test('指纹算法幂等：同输入两次结果相同（否则守卫会随机红）', () => {
    const src = sourceText()
    expect(fingerprint(canonicalBody(src))).toBe(fingerprint(canonicalBody(src)))
  })
})

describe('turn-schema 指纹：过期可判定', () => {
  test('pnpm turn-schema:check 通过（产物未过期）', () => {
    const r = runCheck()
    expect(r.code, `产物过期：\n${r.err || r.out}\n请运行 pnpm turn-schema:sync`).toBe(0)
  })

  // 变异验证的固定化：不改磁盘、只改内存里的源，模拟「改了源没重建」。
  test('变异：源多一个字符 ⇒ 重算哈希必然不同于已嵌入的哈希', () => {
    const embedded = readFingerprint(read(TARGETS[0].rel))
    const mutated = `${canonicalBody(sourceText()).trimEnd()}\n// x\n`
    expect(fingerprint(mutated), '改源后哈希不变 ⇒ 指纹没有覆盖代码体').not.toBe(embedded)
  })

  test('变异：源里改一个字 ⇒ 哈希变（证明守卫对内容敏感，不是只对长度敏感）', () => {
    const src = sourceText()
    const before = fingerprint(canonicalBody(src))
    // 替换第一个 `function` 为 `function`（等长）——等长改动也必须被检出
    const mutated = src.replace('function findCandidates', 'function findCandidatez')
    expect(mutated).not.toBe(src)
    expect(fingerprint(canonicalBody(mutated))).not.toBe(before)
  })
})
