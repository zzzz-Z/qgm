// [reply-extract-parity-v1] `elToMd` / `extractReplyMd` 双通道一致性守卫。
//
// 背景：两处实现分别运行在 page.evaluate 注入侧（headless-inject.ts）与油猴用户脚本
// （tampermonkey-session-id.user.js），无法共享模块。二者若漂移 ⇒ 同一份回复在两条
// 通道反推出不同的 Markdown（换行 / 列表 / 代码围栏丢失形态不同），下游 parseAsk /
// findNewDone / stripScriptBlocks 结论分叉。
//
// [为什么不断言逐字相同] 两处 pre 分支**有意不同**：油猴侧经 codeTextOf 剔除行号
//   （[strip-line-numbers-v1]），headless 侧走内联 replace 尾巴换行。逐字对拍会假红。
//   故本守卫只断言「结构对等」：tag 分支集合一致 + extractReplyMd 骨架一致。
// [判据承重] 任一侧删/增一个 tag 分支、或 extractReplyMd 骨架改形 ⇒ 本用例必红。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const HEADLESS = 'packages/core/src/headless/headless-inject.ts'
const USERSCRIPT = 'scripts/tampermonkey-session-id.user.js'

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8')
}

/** 抠出 `function <name>(...) { <inner> }` 的花括号内部（与 reply-mark-parity 同构） */
function extractInner(src: string, name: string): string {
  const re = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)[^{]*\\{`)
  const m = re.exec(src)
  assert.ok(m, `未找到函数 ${name}`)
  const braceAt = m.index + m[0].length - 1
  let depth = 0
  for (let i = braceAt; i < src.length; i++) {
    const c = src[i]
    if (c === '{') { depth += 1 }
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return src.slice(braceAt + 1, i)
    }
  }
  throw new Error(`${name} 花括号不配平`)
}

/** 从函数体抠出所有 `tag === 'xxx'` 的分支标识（含正则形态 h[1-6]） */
function tagBranches(inner: string): string[] {
  const out = new Set<string>()
  const re = /tag === '([^']+)'/g
  let m
  while ((m = re.exec(inner)) !== null) out.add(m[1])
  if (/\/\^h\[1-6\]\$\/\.test\(tag\)/.test(inner)) out.add('h1-6')
  return [...out].sort()
}

test('elToMd: 双通道的 tag 分支集合一致', () => {
  const a = tagBranches(extractInner(read(HEADLESS), 'elToMd'))
  const b = tagBranches(extractInner(read(USERSCRIPT), 'elToMd'))
  assert.deepEqual(a, b, `elToMd 的 tag 分支集合漂移：headless=${a.join(',')} userscript=${b.join(',')}`)
  assert.ok(a.length >= 8, 'elToMd 至少应覆盖 8 类标签（br/hr/h1-6/p/ul|ol/pre/code/blockquote/table）')
})

test('extractReplyMd: 双通道骨架一致（非空守卫 → nodeType===9 取 body → elToMd → 折叠 → trim）', () => {
  for (const rel of [HEADLESS, USERSCRIPT]) {
    const inner = extractInner(read(rel), 'extractReplyMd')
    assert.ok(/if \(!root\)\s*return '';?/.test(inner), `${rel}: 缺 root 空守卫`)
    assert.ok(/nodeType === 9/.test(inner), `${rel}: 缺 document 特判（取 body）`)
    assert.ok(/elToMd\(node\)/.test(inner), `${rel}: 未调用 elToMd`)
    assert.ok(/replace\(\/\\n\{3,\}\/g, '\\n\\n'\)/.test(inner), `${rel}: 缺多空行折叠`)
    assert.ok(/\.trim\(\)/.test(inner), `${rel}: 缺首尾 trim`)
  }
})
