// @desc 把 turn 信封契约的唯一源同步到各运行端产物，并嵌入内容指纹
// @why 无头侧走 page.evaluate（不能 import）、油猴是单文件 IIFE（不能 import）、前端是另一个包
//   —— 三处都必须有同一份解析器。靠人手复制必然漂移：历史上有过「解析对了但字段没被采信」
//   （attach-ws.ts:147 把脚本 desc/why 硬编码成空串）这种守卫看不见的缺口。
//   本脚本把「同一份源码」从构建期的一句承诺变成可判定的指纹，由 reply-turn-fingerprint 对拍。
// @change-impact 改 packages/core/src/reply/turn-schema.ts 后必须重跑 pnpm turn-schema:sync，
//   否则守卫报「源哈希 ≠ 产物嵌入哈希」。
//
// 用法：node scripts/sync-turn-schema.mjs [--check]
//   --check 只校验不写盘（供 CI / 守卫调用）；不一致时 exit 1
//
// [CONSTRAINT] 本文件只做 IO，算法全在 scripts/lib/turn-schema-io.mjs。
//   守卫必须 import 同一套算法；若算法留在入口里，import 一次就会写一次盘。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalBody, fingerprint, render, renderInline, sharedBody, SOURCE_REL, TARGETS } from './lib/turn-schema-io.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, SOURCE_REL)
const checkOnly = process.argv.includes('--check')

const raw = readFileSync(SRC, 'utf8')
// 源哈希只算一次：三处产物嵌入同一个值，才叫「同一份源码」
const hash = fingerprint(canonicalBody(raw))
let drifted = 0

for (const target of TARGETS) {
  const body = sharedBody(raw, target.mode)
  const abs = join(ROOT, target.rel)
  const prev = existsSync(abs) ? readFileSync(abs, 'utf8') : null
  const next = target.kind === 'inline'
    ? (prev === null ? null : renderInline(prev, body, hash))
    : render(target, body, hash)
  if (next === null) {
    drifted += 1
    console.error(`[turn-schema] ✗ ${target.rel} 缺 ${'// >>> BEGIN turn-schema'} / END 标记，无法定位内联区段`)
    continue
  }
  if (prev === next) {
    console.log(`[turn-schema] = ${relative(ROOT, abs)} (${hash})`)
    continue
  }
  if (checkOnly) {
    drifted += 1
    console.error(`[turn-schema] ✗ ${relative(ROOT, abs)} 与源不一致（期望 ${hash}）`)
    continue
  }
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, next, 'utf8')
  console.log(`[turn-schema] ${prev === null ? '+' : '~'} ${relative(ROOT, abs)} (${hash})`)
}

if (drifted > 0) {
  console.error(`[turn-schema] ${drifted} 处产物过期，请运行 pnpm turn-schema:sync`)
  process.exit(1)
}
