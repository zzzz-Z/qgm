// AIRUNNER-BATCH24-3-WEB-SERVER: server 侧测试（原 test/post-run-script-check.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/post-run-script-check.node-test.ts 迁至 test/post-run-script-check.node-test.ts
// AIRUNNER-BATCH22-1-CONSOLIDATE: 从 src/post-run/script-check.node-test.ts 迁至 client/test/post-run-script-check.node-test.ts
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { checkScriptSyntax } from '../../packages/core/src/post-run/script-check.ts'

const NL = String.fromCharCode(10)

test('合法 JS：原样通过 → ok=true', () => {
  assert.deepEqual(checkScriptSyntax('const a = 1'), { ok: true })
})

test('合法 shebang + JS：原样即可解析', () => {
  const code = `#!/usr/bin/env node${NL}const a = 1`
  assert.deepEqual(checkScriptSyntax(code), { ok: true })
})

test('带 BOM 的 shebang 脚本：降级后 ok', () => {
  const BOM = String.fromCharCode(0xFEFF)
  const code = `${BOM}#!/usr/bin/env node${NL}const a = 1`
  assert.deepEqual(checkScriptSyntax(code), { ok: true })
})

test('前导空白 + shebang：降级后 ok', () => {
  const code = `   #!/usr/bin/env node${NL}const a = 1`
  assert.deepEqual(checkScriptSyntax(code), { ok: true })
})

test('CRLF shebang：降级后 ok', () => {
  const code = `#!/usr/bin/env node${String.fromCharCode(13, 10)}const a = 1`
  assert.deepEqual(checkScriptSyntax(code), { ok: true })
})

test('CR shebang：降级后 ok', () => {
  const code = `#!/usr/bin/env node${String.fromCharCode(13)}const a = 1`
  assert.deepEqual(checkScriptSyntax(code), { ok: true })
})

test('裸 shebang 无换行：剥 shebang 后为空字符串 → ok', () => {
  // 空字符串是合法 JS 程序；确认当前不报错
  const r = checkScriptSyntax(`#!/usr/bin/env node${NL}`)
  assert.deepEqual(r, { ok: true })
})

test('语法错误：整体失败 → ok=false 且带错误信息', () => {
  const r = checkScriptSyntax('const = ;')
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(typeof r.error, 'string')
    assert.ok(r.error.length > 0)
  }
})

test('失败时 error 附带前 80 字符预览', () => {
  const r = checkScriptSyntax('const = ;')
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.ok(r.error.includes('前 80 字符：'))
  }
})

test('预览中的换行被转义为 \\n', () => {
  const bad = `const a = 1${NL}const = ;`
  const r = checkScriptSyntax(bad)
  assert.equal(r.ok, false)
  if (!r.ok) {
    const idx = r.error.indexOf('前 80 字符：')
    assert.ok(idx >= 0)
    const preview = r.error.slice(idx + '前 80 字符：'.length)
    assert.ok(preview.includes(`${String.fromCharCode(92)}n`), '换行应被转义')
  }
})

test('bash 脚本（非 JS）：会尝试剥首行，多数仍失败', () => {
  const code = `#!/usr/bin/env bash${NL}echo hi`
  const r = checkScriptSyntax(code)
  assert.equal(r.ok, false)
})

test('剥首行后合法：原样失败 → 兜底成功 ok=true', () => {
  // 第一行是非法 JS 语句，第二行是合法 JS；兜底剥首行后应通过
  const code = `this is not js !!!${NL}const a = 1`
  const r = checkScriptSyntax(code)
  assert.deepEqual(r, { ok: true })
})
