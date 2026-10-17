// [tampermonkey-split-v1] 用户脚本按职责拆到 packages/core/src/tampermonkey/*.ts，
//   由 scripts/lib/userscript-segments.mjs 组装成 scripts/tampermonkey-session-id.user.js。
// [WHY] 其余守卫读的都是产物路径；只要「产物 = buildUserscript(片段)」成立，它们的校验依然有效。
//   若有人直接改产物而不同步片段，两边会静默分叉——本用例就是那条判据。
// [CONSTRAINT] 守卫与 assemble 共用同一份 buildUserscript，不做第二次拼接实现：
//   各写一份必然在剥注释/换行细节上漂移，而那种漂移恰好会让「一致」的断言永远为假。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'

const ROOT = process.cwd()
const SRC_DIR = join(ROOT, 'packages/core/src/tampermonkey')
const OUT_FILE = join(ROOT, 'scripts/tampermonkey-session-id.user.js')

// [tampermonkey-split-v2] 组装逻辑在 beforeAll 里解析：
//   · top-level await 违反 antfu/no-top-level-await（仓库统一禁用）
//   · 静态 import 的 .mjs 在 tsconfig.test.json 下无类型声明，只能靠动态解析 + 显式类型
// [CONSTRAINT] 路径相对 tests/ 上溯三层到仓库根（tests → core → packages → root）
let buildUserscript: (srcDir: string) => string
let SEGMENTS: string[]

beforeAll(async () => {
  // @ts-expect-error .mjs 无类型声明，且 scripts/ 不在 tsconfig.test.json 的 include 内
  const mod = await import('../../../scripts/lib/userscript-segments.mjs')
  buildUserscript = mod.buildUserscript
  SEGMENTS = mod.SEGMENTS
})

function read(path: string): string {
  return readFileSync(path, 'utf8')
}

describe('tampermonkey-split', () => {
  test('产物必须等于 buildUserscript(片段)', () => {
    expect(read(OUT_FILE)).toBe(buildUserscript(SRC_DIR))
  })

  // [userscript-version-inject-v1] 版本号不在片段里，由 scripts/tampermonkey-version.json 注入。
  // [WHY] 两个新失效模式此前无判据：① 注入没生效 → 产物留占位符，油猴拿它当版本比较，更新链路静默失效；
  //   ② 有人把版本写回片段 → 与版本文件分叉，构建再也无法自动递增（比对恒为「有变」而无限 bump）。
  test('版本注入：产物无占位符、版本文件与产物一致、片段里不写死版本', () => {
    const out = read(OUT_FILE)
    expect(out).not.toContain('__TM_VERSION__')
    const ver = JSON.parse(read(join(ROOT, 'scripts/tampermonkey-version.json'))).version as string
    expect(out.includes(`// @version      ${ver}`), '产物 @version 必须等于版本文件的值').toBe(true)
    for (const name of SEGMENTS) {
      if (name === 'header') continue
      expect(read(join(SRC_DIR, `${name}.ts`)), `${name}.ts 不应出现 @version 声明`).not.toMatch(/^\/\/ @version/m)
    }
    const hd = read(join(SRC_DIR, 'header.ts'))
    expect(hd).toContain('__TM_VERSION__')
    expect(hd).not.toMatch(/^\/\/ @version\s+\d/m)
  })
  test('每个片段都非空', () => {
    for (const name of SEGMENTS) {
      expect(read(join(SRC_DIR, `${name}.ts`)).length, `${name}.ts 为空`).toBeGreaterThan(0)
    }
  })

  test('@version 只在 header 片段声明', () => {
    for (const name of SEGMENTS) {
      const hits = (read(join(SRC_DIR, `${name}.ts`)).match(/^\/\/ @version/gm) || []).length
      if (name === 'header') expect(hits, 'header.ts 必须且只能声明一次 @version').toBe(1)
      else expect(hits, `${name}.ts 不应声明 @version`).toBe(0)
    }
  })
})
