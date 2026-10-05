// AIRUNNER-BATCH24-3-WEB-SERVER: server 侧测试（原 test/post-run-script-check.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/post-run-script-check.node-test.ts 迁至 test/post-run-script-check.node-test.ts
// AIRUNNER-BATCH22-1-CONSOLIDATE: 从 src/post-run/script-check.node-test.ts 迁至 client/test/post-run-script-check.node-test.ts
import { test } from 'vitest'
import assert from 'node:assert/strict'
import {
  checkScriptSyntax,
  hasUnclosedStructure,
  isTruncatedScript,
  MAX_SCRIPT_BYTES,
  MAX_SCRIPT_LINES,
  measureScriptSize,
} from '../../../packages/core/src/post-run/script-check.js'

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

// ─────────────────────────────────────────────────────────────────────────────
// [truncation-detect-v1] 截断识别
//
// 判据必须两条同时成立：① 错误消息属「截断族」② 存在未闭合结构。
// 实测消息（node 22.22，`.ai-runner/tmp/probe-truncation-msgs.mjs`）：
//   截断 → `Unexpected end of input` / `Invalid or unexpected token`
//   真错 → `Unexpected token '='` / `')'` / `'}'`（与截断族零重叠）
// ─────────────────────────────────────────────────────────────────────────────

/** 断言「被判为截断」 */
function assertTruncated(code: string): void {
  const r = checkScriptSyntax(code)
  assert.equal(r.ok, false, `应有语法错误：${JSON.stringify(code.slice(0, 60))}`)
  if (!r.ok) assert.equal(r.truncated, true, `应判为截断：${r.error}`)
}

/** 断言「不得被判为截断」 */
function assertNotTruncated(code: string): void {
  const r = checkScriptSyntax(code)
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.truncated, false, `不得判为截断：${r.error}`)
}

test('截断：截在函数体内（未闭合花括号）→ Unexpected end of input', () => {
  assertTruncated(`const a = 1${NL}function f() {${NL}  return 2`)
})

test('截断：截在调用参数中途（未闭合圆括号）', () => {
  assertTruncated(`const a = 1${NL}patchFile({ path: 'x', find: 'a',`)
})

test('截断：截在数组字面量中途（未闭合方括号）', () => {
  assertTruncated('const rows = [1, 2, 3')
})

test('截断：截在模板字面量中途（未闭合反引号）', () => {
  assertTruncated(`const a = 1${NL}const s = ${String.fromCharCode(96)}abc`)
})

test('截断：截在字符串中途（Invalid or unexpected token 族）', () => {
  assertTruncated(`const a = 1${NL}const s = 'abc`)
})

test('截断：截在块注释中途（Invalid or unexpected token 族）', () => {
  assertTruncated(`const a = 1${NL}/* 注释没结束`)
})

test('截断：带 shebang + @desc 的真脚本头，仍能识别', () => {
  assertTruncated(`#!/usr/bin/env node${NL}// @desc x${NL}function f() {${NL}  return 1`)
})

test('真语法错：闭合但非法（const = ;）不得判为截断', () => {
  assertNotTruncated('const = ;')
})

test('真语法错：孤立右括号不得判为截断', () => {
  assertNotTruncated('const a = 1)')
})

test('真语法错：多余右花括号不得判为截断', () => {
  assertNotTruncated('const a = 1}')
})

test('合法脚本：ok=true 且不带 truncated 字段（保持既有调用方 deepEqual 兼容）', () => {
  assert.deepEqual(checkScriptSyntax('const a = 1'), { ok: true })
})

test('hasUnclosedStructure：字符串/注释里的括号不参与计数', () => {
  // 这三个都是**闭合**的：括号出现在字符串与注释里，不得被当成未闭合
  assert.equal(hasUnclosedStructure(`const s = '((('`), false)
  assert.equal(hasUnclosedStructure(`const s = "]]]"`), false)
  assert.equal(hasUnclosedStructure(`// (((`), false)
  assert.equal(hasUnclosedStructure(`/* ((( */`), false)
})

test('hasUnclosedStructure：转义引号不提前终结字符串', () => {
  assert.equal(hasUnclosedStructure(String.raw`const s = 'a\'b'`), false)
})

test('hasUnclosedStructure：末尾停在行注释里属于正常（不算未闭合）', () => {
  assert.equal(hasUnclosedStructure(`const a = 1 // 收尾注释`), false)
  assert.equal(hasUnclosedStructure(`const a = 1 // 收尾注释${NL}`), false)
})

test('hasUnclosedStructure：真未闭合一律为 true', () => {
  assert.equal(hasUnclosedStructure('const a = ('), true)
  assert.equal(hasUnclosedStructure('const a = {'), true)
  assert.equal(hasUnclosedStructure(`const s = 'abc`), true)
  assert.equal(hasUnclosedStructure('/* 没结束'), true)
})

test('isTruncatedScript：消息属截断族但结构完整 → 不算截断（防空判）', () => {
  // `Unexpected end of input` 却括号平衡，说明不是尾部切断
  assert.equal(isTruncatedScript('const a = 1', 'Unexpected end of input'), false)
})

test('isTruncatedScript：结构未闭合但消息不属截断族 → 不算截断（防空判）', () => {
  assert.equal(isTruncatedScript('const a = (', 'Unexpected token \'=\''), false)
})

// ─────────────────────────────────────────────────────────────────────────────
// [truncation-detect-v1] 体积度量（§10 预算的机制化）
// ─────────────────────────────────────────────────────────────────────────────

test('measureScriptSize：小脚本不超预算', () => {
  const s = measureScriptSize(`const a = 1${NL}const b = 2`)
  assert.equal(s.lines, 2)
  assert.equal(s.overBudget, false)
  assert.equal(s.maxLines, MAX_SCRIPT_LINES)
  assert.equal(s.maxBytes, MAX_SCRIPT_BYTES)
})

test('measureScriptSize：行数超限即判超预算', () => {
  const s = measureScriptSize(Array.from({ length: MAX_SCRIPT_LINES + 1 }).fill('x').join(NL))
  assert.equal(s.lines, MAX_SCRIPT_LINES + 1)
  assert.equal(s.overBudget, true)
})

test('measureScriptSize：字节超限即判超预算（少数超长行也能触发）', () => {
  const s = measureScriptSize('x'.repeat(MAX_SCRIPT_BYTES + 1))
  assert.equal(s.overBudget, true)
  assert.ok(s.lines < MAX_SCRIPT_LINES, '行数并未超限，说明触发点确实是字节数')
})

test('measureScriptSize：CRLF 按一行计，不虚增行数', () => {
  assert.equal(measureScriptSize(`a${String.fromCharCode(13, 10)}b`).lines, 2)
})

test('measureScriptSize：空脚本行数为 0 而非 1', () => {
  assert.equal(measureScriptSize('').lines, 0)
  assert.equal(measureScriptSize('').overBudget, false)
})

test('measureScriptSize：中文字节按 UTF-8 计（不是字符数）', () => {
  // '中' = 3 字节 / 1 字符；只按字符数度量会低估 3 倍
  assert.equal(measureScriptSize('中').bytes, 3)
})
