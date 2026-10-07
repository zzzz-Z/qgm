// [runtime-cjs-copy-v1] 构建期 runtime .cjs 复制清单守卫。
// [WHY] 源码用 new URL('../<name>.cjs', import.meta.url) 定位运行时 spawn 的 .cjs；
//   vitest/tsc 都从源码树跑 ⇒ 恒命中 packages/core/src/<name>.cjs，永远测不到「构建没复制」。
//   bundle 落在 apps/standalone/dist/_server/index.js ⇒ 解析成 apps/standalone/dist/<name>.cjs。
// CHANGE-IMPACT: 清单漏项 ⇒ 发布态该子进程 Cannot find module（实测 /session 帧 500 REPL_EXITED）。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SRC_DIR = path.join(ROOT, 'packages', 'core', 'src')
const BUILD_ALL = path.join(ROOT, 'scripts', 'build-all.mjs')
const COPY_RUNTIME = path.join(ROOT, 'scripts', 'copy-runtime.cjs')
const COPY_RUNTIME_CORE = path.join(ROOT, 'packages', 'core', 'scripts', 'copy-runtime.cjs')

/** 抽出文件里形如 ['a.cjs', 'b.cjs'] 的复制清单（含 .cjs 字面量的数组） */
function readCopyList(file: string): Set<string> {
  const txt = fs.readFileSync(file, 'utf8')
  const names = new Set<string>()
  for (const arr of txt.matchAll(/\[[^\]]*\]/g)) {
    for (const m of arr[0].matchAll(/'([\w.-]+\.cjs)'/g)) names.add(m[1])
  }
  return names
}

/** 扫 packages/core/src 下所有 new URL('../<name>.cjs', import.meta.url) 引用 */
function referencedRuntimeCjs(): Set<string> {
  const out = new Set<string>()
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!e.name.endsWith('.ts')) continue
      for (const m of fs.readFileSync(p, 'utf8').matchAll(/new URL\(\s*'\.\.\/([\w.-]+\.cjs)'/g)) out.add(m[1])
    }
  }
  walk(SRC_DIR)
  return out
}

const REFERENCED = referencedRuntimeCjs()
const BUILD_LIST = readCopyList(BUILD_ALL)
const COPY_LIST = readCopyList(COPY_RUNTIME)
const COPY_LIST_CORE = readCopyList(COPY_RUNTIME_CORE)

test('源码确实引用了运行时 .cjs（防空转）', () => {
  assert.ok(REFERENCED.size >= 3, `expected >=3 referenced runtime cjs, got [${[...REFERENCED].join(', ')}]`)
})

test('每个被引用的 .cjs 在 src 中真实存在', () => {
  for (const n of REFERENCED) {
    assert.ok(fs.existsSync(path.join(SRC_DIR, n)), `missing source file packages/core/src/${n}`)
  }
})

test('build-all.mjs 复制清单覆盖全部被引用 .cjs', () => {
  for (const n of REFERENCED) {
    assert.ok(BUILD_LIST.has(n), `scripts/build-all.mjs 缺 ${n} ⇒ apps/standalone/dist/${n} 不会存在`)
  }
})

test('copy-runtime.cjs 复制清单覆盖全部被引用 .cjs', () => {
  for (const n of REFERENCED) {
    assert.ok(COPY_LIST.has(n), `scripts/copy-runtime.cjs 缺 ${n} ⇒ dist/${n} 不会存在`)
  }
})

test('core 版 copy-runtime.cjs 清单亦覆盖全部被引用 .cjs（消盲区）', () => {
  for (const n of REFERENCED) {
    assert.ok(COPY_LIST_CORE.has(n), `packages/core/scripts/copy-runtime.cjs 缺 ${n} ⇒ packages/core/dist/${n} 不会存在`)
  }
})

test('repl-loop.cjs 必须在两份清单内（/session 子进程入口）', () => {
  assert.ok(BUILD_LIST.has('repl-loop.cjs'), 'build-all.mjs 缺 repl-loop.cjs')
  assert.ok(COPY_LIST.has('repl-loop.cjs'), 'copy-runtime.cjs 缺 repl-loop.cjs')
})
