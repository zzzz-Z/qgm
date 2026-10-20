// AIRUNNER-BATCH24-3-WEB-SERVER: server 侧测试（原 test/post-run-run-script-wrapper.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/post-run-run-script-wrapper.node-test.ts 迁至 test/post-run-run-script-wrapper.node-test.ts
// AIRUNNER-BATCH22-1-CONSOLIDATE: 从 src/post-run/run-script-wrapper.node-test.ts 迁至 client/test/post-run-run-script-wrapper.node-test.ts
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { buildWrapperCode } from '../../../packages/core/src/post-run/run-script-wrapper.js'

// [return-echo-guard-v1] 行为级判据：真实执行 wrapper 产物，而非只断言源码含某字符串。
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// AIRUNNER-BATCH11-4-WRAPPER-TEST
const SAMPLE = '/tmp/x/script.cjs'

test('返回值包含 uncaughtException 监听', () => {
  const c = buildWrapperCode(SAMPLE)
  assert.ok(c.includes('uncaughtException'))
})

test('返回值包含 unhandledRejection 监听', () => {
  const c = buildWrapperCode(SAMPLE)
  assert.ok(c.includes('unhandledRejection'))
})

test('捕获块将 process.exitCode 置 1', () => {
  const c = buildWrapperCode(SAMPLE)
  assert.ok(c.includes('process.exitCode = 1'))
})

test('内插 scriptPath 用 JSON 安全转义', () => {
  const c = buildWrapperCode(SAMPLE)
  assert.ok(c.includes(JSON.stringify(SAMPLE)))
})

test('特殊字符路径被安全转义', () => {
  const p = '/tmp/a"b/c\\d.cjs'
  const c = buildWrapperCode(p)
  assert.ok(c.includes(JSON.stringify(p)), 'expect JSON-escaped path in output')
})

test('返回值包含 require(scriptPath) 调用', () => {
  const c = buildWrapperCode(SAMPLE)
  assert.ok(/require\(/.test(c))
})

test('返回值包含 [script error] 标签', () => {
  const c = buildWrapperCode(SAMPLE)
  assert.ok(c.includes('[script error]'))
})

test('返回值含 try / catch 结构', () => {
  const c = buildWrapperCode(SAMPLE)
  assert.ok(c.includes('try {'))
  // [return-echo-v1] catch 变量名改为 __e（避开与脚本内 e 的潜在冲突），断言放宽为匹配任意 catch 变量
  assert.ok(/catch\s*\(\s*\w+\s*\)/.test(c))
})

test('相同入参产生相同输出（确定性）', () => {
  assert.equal(buildWrapperCode(SAMPLE), buildWrapperCode(SAMPLE))
})

test('不同 scriptPath 产生不同输出', () => {
  assert.notEqual(buildWrapperCode('/a.cjs'), buildWrapperCode('/b.cjs'))
})

test('返回值为字符串（非 undefined）', () => {
  const c = buildWrapperCode(SAMPLE)
  assert.equal(typeof c, 'string')
  assert.ok(c.length > 0)
})

function runWrapped(scriptBody: string, opts: { captureStderr?: boolean } = {}): string {
  void opts
  const dir = mkdtempSync(join(tmpdir(), 'wrap-'))
  const scriptPath = join(dir, 'probe.cjs')
  writeFileSync(scriptPath, scriptBody)
  const code = buildWrapperCode(scriptPath)
  // [return-echo-guard-v1] 抛错走 stderr，观察面必须合并两路，否则断言假红
  try {
    return execFileSync(process.execPath, ['-e', code], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    const err = e as { stdout?: string, stderr?: string }
    return String(err.stdout || '') + String(err.stderr || '')
  }
}

test('无任何输出时，顶层 return 的字符串被写入 stdout', () => {
  const out = runWrapped('return \'RETURN_ECHO_OK\'\n')
  assert.ok(out.includes('RETURN_ECHO_OK'), `return 值必须被回灌，实际: ${out}`)
})

test('已有输出时不重复打印 return 值', () => {
  const out = runWrapped('console.log(\'REAL\')\nreturn \'SHOULD_NOT_PRINT\'\n')
  assert.ok(out.includes('REAL'))
  assert.ok(!out.includes('SHOULD_NOT_PRINT'), `已输出时不得重复，实际: ${out}`)
})

test('脚本抛错时报错可见且不吞', () => {
  const out = runWrapped('throw new Error(\'BOOM\')\n', { captureStderr: true })
  assert.ok(out.includes('BOOM'), `异常必须可见，实际: ${out}`)
})

// [wrapper-fingerprint-v1] wrapper 的关键结构指纹。
// [WHY] 本会话实测：run-script-wrapper.ts 曾被静默回滚——`vm.runInThisContext` / return-echo /
//   emitApiDoc 的改动全部消失，而没有任何测试变红（因为旧测试只断言「含 require」这类弱判据）。
//   [CONSTRAINT] 断言的是「行为结构」而非精确文本：允许注释/换行调整，但不允许能力被删。
test('wrapper 保留关键能力（防静默回滚）', () => {
  const code = buildWrapperCode('/tmp/x.cjs')
  // 必须捕获未处理异常（否则脚本崩溃无输出）
  assert.ok(code.includes('uncaughtException'), 'wrapper 丢失 uncaughtException 捕获')
  assert.ok(code.includes('unhandledRejection'), 'wrapper 丢失 unhandledRejection 捕获')
  // 必须能加载脚本（require 或 vm 求值，二者存其一即可）
  assert.ok(/require\(|runInThisContext/.test(code), 'wrapper 丢失脚本加载能力')
  // 失败必须可见
  assert.ok(code.includes('[script error]'), 'wrapper 丢失错误输出标记')
})
