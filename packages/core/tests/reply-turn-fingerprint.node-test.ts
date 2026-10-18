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
import { describe, expect, test } from 'vitest'
import { BEGIN, canonicalBody, extractBody, fingerprint, readFingerprint, sharedBody, SOURCE_REL, TARGETS } from '../../../scripts/lib/turn-schema-io.mjs'

const ROOT = process.cwd()
const SYNC = 'scripts/sync-turn-schema.mjs'

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
  test('三处产物都已注册且文件存在（前端 / 油猴 / 无头内联）', () => {
    expect(TARGETS.length, '缺一处运行端 ⇒ 该端只能手抄解析器').toBe(3)
    expect(TARGETS.filter(t => t.kind === 'inline').length, '无头必须走 inline 段').toBe(1)
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

  test('外壳适配：module 保留 export，fragment/inline 不得有顶层 export', () => {
    // [CONSTRAINT] 逐产物断言，不用 Map<mode, body>——三处里有两处同 mode，
    //   按 mode 建索引会互相覆盖，于是只校验到最后一条，前面那条的违规无人发现。
    for (const t of TARGETS) {
      const body = extractBody(read(t.rel)) ?? ''
      if (t.mode === 'module') {
        expect(body, `${t.rel} 必须导出 parseTurn 供前端 import`).toContain('export function parseTurn')
      }
      else {
        expect(body, `${t.rel} 里的 export 会进 IIFE/函数体，直接 SyntaxError`).not.toMatch(/^export /m)
      }
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

// [WHY] inline 段与整文件产物有**两种只属于它的失效模式**，指纹与代码体断言都看不见：
//   ① 生成器退化成「整文件覆盖」⇒ 宿主函数被抹掉，但指纹与代码体依然逐字正确；
//   ② 段被贴到模块顶层 ⇒ 语法正确、指纹正确，但 page.evaluate 序列化时它根本不在函数体内，
//      浏览器侧永远看不到它（正是本方案要消灭的「静默失效」）。
describe('turn-schema 指纹：无头内联段的位置约束', () => {
  const INLINE = 'packages/core/src/headless/headless-inject.ts'

  test('区外内容原样保留：宿主两个导出函数仍在', () => {
    const text = read(INLINE)
    expect(text, 'inline 生成覆盖了整文件，宿主被抹掉').toContain('export function detectReplyInPage')
    expect(text).toContain('export function ensureCollectorInPage')
  })

  test('段必须在函数体内（BEGIN 行有缩进），否则 page.evaluate 序列化时它不在作用域', () => {
    const beginLine = read(INLINE).split('\n').find(l => l.includes(BEGIN)) ?? ''
    expect(beginLine, `${INLINE} 里没有 BEGIN 标记`).not.toBe('')
    expect(beginLine, 'BEGIN 标记顶格 ⇒ 段在模块顶层，浏览器侧看不到').toMatch(/^\s+\/\//)
  })

  test('生成器的 inline 渲染是幂等的：连跑两次不追加第二份指纹', () => {
    const r = runCheck()
    expect(r.code).toBe(0)
    const hits = read(INLINE).match(/@turn-schema:[0-9a-f]{16}/g) ?? []
    expect(hits.length, 'inline 段每次生成都新写一行指纹 ⇒ 第二次就重复').toBe(1)
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
