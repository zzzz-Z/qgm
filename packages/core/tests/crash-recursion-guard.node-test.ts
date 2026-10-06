// [crash-recursion-guard-v1] 守卫 logCrash 递归修复：
//   stderr 断开(EIO)时 console.error 会抛异常 → 再触发 uncaughtException → 无限递归。
//   实测 2026-10-05：295ms 内 933 次同源崩溃。
// 静态断言（server.ts 是宿主入口，无法运行时 import）。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()
const SERVER_SRC = 'apps/standalone/src/server.ts'

function readServer(): string {
  return fs.readFileSync(path.join(ROOT, SERVER_SRC), 'utf8')
}

test('P0-2: logCrash 含递归闸门 _inCrash', () => {
  const src = readServer()
  assert.match(src, /let _inCrash = false/, '缺少 _inCrash 声明')
  assert.match(src, /if \(_inCrash\) return/, '缺少递归闸门')
})

test('P0-2: 首句 console.error 被 try 包裹', () => {
  const src = readServer()
  assert.match(src, /try \{ console\.error\(`✗ \[air-server\]/, '首句 stderr 写必须包 try')
})

test('P0-2: logCrash 内不再有裸 console.error', () => {
  const src = readServer()
  const i = src.indexOf('function logCrash(')
  const j = src.indexOf('process.on(', i)
  const body = src.slice(i, j)
  // [guard-comment-exempt] 注释里提及 console.error 字样不算裸调用（否则说明文字本身会让守卫误报）
  const naked = body.split('\n')
    .filter(l => !/^\s*(?:\/\/|\*)/.test(l))
    .filter(l => /console\.error/.test(l) && !/try \{ console\.error/.test(l))
  assert.deepEqual(naked, [], `仍有裸 console.error: ${naked.join(' | ')}`)
})
