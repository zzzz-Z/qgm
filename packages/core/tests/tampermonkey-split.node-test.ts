// [tampermonkey-split-v1] 油猴脚本按职责拆到 packages/core/src/tampermonkey/*.js，
//   由 scripts/assemble-userscript.mjs 拼回 scripts/tampermonkey-session-id.user.js。
// [WHY] 其余守卫读的都是产物路径；只要「产物 = 片段按序拼接」成立，它们的校验依然有效。
//   若有人直接改产物而不同步片段，两边会静默分叉——本用例就是那条判据。
// [CONSTRAINT] SEGMENTS 顺序即 IIFE 内声明顺序，改动必须与 assemble 脚本同步。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

const ROOT = process.cwd()
const SRC_DIR = join(ROOT, 'packages/core/src/tampermonkey')
const OUT_FILE = join(ROOT, 'scripts/tampermonkey-session-id.user.js')
const SEGMENTS = ['header', 'channel', 'parse', 'stop', 'dispatch', 'observer', 'dom', 'listener']

/** 读片段/产物文本；路径拼在调用处，便于失败时直接看出是哪个文件 */
function read(path: string): string {
  return readFileSync(path, 'utf8')
}

describe('tampermonkey-split', () => {
  test('片段按序拼接必须与产物逐字节一致', () => {
    const rebuilt = SEGMENTS.map(name => read(join(SRC_DIR, `${name}.js`))).join('\n')
    const shipped = read(OUT_FILE)
    expect(shipped).toBe(rebuilt)
  })

  test('每个片段都非空', () => {
    for (const name of SEGMENTS) {
      expect(read(join(SRC_DIR, `${name}.js`)).length, `${name}.js 为空`).toBeGreaterThan(0)
    }
  })

  test('@version 只在 header 片段声明', () => {
    for (const name of SEGMENTS) {
      const hits = (read(join(SRC_DIR, `${name}.js`)).match(/^\/\/ @version/gm) || []).length
      if (name === 'header') expect(hits, 'header.js 必须且只能声明一次 @version').toBe(1)
      else expect(hits, `${name}.js 不应声明 @version`).toBe(0)
    }
  })
})
