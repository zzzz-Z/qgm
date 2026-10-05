// [ai-guard-fallback-v2] ai-guard 单测：原生 API 严格扫描、降级协议豁免、__AI__ API 速查幂等注入
import { describe, expect, it } from 'vitest'
import { injectAiJsdoc, scanNativeApis, scanNativeApisWithFallback, tokenize } from '../../../packages/core/src/post-run/ai-guard.js'

const NL = String.fromCharCode(10)

describe('scanNativeApis (原生 API 扫描)', () => {
  it('合规 __AI__ 脚本通过', () => {
    expect(scanNativeApis('const t = __AI__.readText(\'a.txt\')').hit).toBe(false)
  })
  it('require(fs) 命中', () => {
    expect(scanNativeApis('const fs = require(\'fs\')').hit).toBe(true)
  })
  it('fs.readFileSync 命中', () => {
    expect(scanNativeApis('fs.readFileSync(\'x\')').hit).toBe(true)
  })
  it('行注释片段被忽略', () => {
    expect(scanNativeApis('// fs.readFileSync\nconst x=1').hit).toBe(false)
  })
  it('块注释片段被忽略', () => {
    expect(scanNativeApis('/* path.join */\nconst x=1').hit).toBe(false)
  })
  it('process.exit 命中', () => {
    expect(scanNativeApis('process.exit(1)').hit).toBe(true)
  })
})

describe('scanNativeApisWithFallback (降级协议)', () => {
  it('无标记仍命中', () => {
    expect(scanNativeApisWithFallback('const fs = require(\'fs\')').hit).toBe(true)
  })
  it('3 行内标记豁免', () => {
    const code = ['// __AI__.patchFile not found', 'const fs = require(\'fs\')'].join('\n')
    expect(scanNativeApisWithFallback(code).hit).toBe(false)
  })
  it('标记过远仍命中', () => {
    const code = ['// __AI__.patchFile not found', '// g1', '// g2', '// g3', '// g4', 'const fs = require(\'fs\')'].join('\n')
    expect(scanNativeApisWithFallback(code).hit).toBe(true)
  })
})

describe('injectAiJsdoc (__AI__ API 速查)', () => {
  it('prepend JSDoc 且保留原文', () => {
    const out = injectAiJsdoc('const x = 1\n')
    expect(out).toContain('__AI__ 运行时沙箱')
    expect(out).toContain('const x = 1')
  })
  it('幂等：二次注入不变', () => {
    const once = injectAiJsdoc('const x = 1\n')
    expect(injectAiJsdoc(once)).toBe(once)
  })
  it('shebang 保留在首行', () => {
    const out = injectAiJsdoc('#!/usr/bin/env node\nconst x = 1\n')
    expect(out.startsWith('#!/usr/bin/env node')).toBe(true)
    expect(out).toContain('__AI__ 运行时沙箱')
  })
})

// [ai-guard-tokenize-v2] 词法剥离：只对「可执行代码」判定，「要写入的文本」不再误伤。
// 每条都刻意选「旧实现会给出相反结果」的构造，属承重判据（条件恒真时会变红）。
describe('tokenize / 字面量剥离', () => {
  it('字面量内容替换为空格但换行保留（行数不变）', () => {
    const t = tokenize(['const a = `x', 'y`', 'const b = "z"'].join(NL))
    expect(t.code.split(NL).length).toBe(3)
    expect(t.code.includes('x')).toBe(false)
    expect(t.code.includes('"z"')).toBe(false)
    expect(t.literals).toEqual(['x\ny', 'z'])
  })

  it('注释里的撇号不再吞掉后续代码', () => {
    const code = ['// 别写死 path，don\'t 这样', 'const fs = require(\'fs\')'].join(NL)
    const r = scanNativeApis(code)
    expect(r.hit).toBe(true)
    expect(r.matches).toContain('require(fs)')
  })

  it('require / import 的模块名是语义参数，不剥离', () => {
    expect(scanNativeApis('import fs from \'node:fs\'').hit).toBe(true)
    expect(scanNativeApis('const cp = require("child_process")').hit).toBe(true)
  })

  it('作为文本写入的黑名单词不再拦截（D-0b 真实误伤形态）', () => {
    const code = [
      'const arr = [',
      '  "  TMP = fs.mkdtempSync(path.join(os.tmpdir(), \'sc-l2-\'))",',
      '  "  fs.rmSync(TMP, { recursive: true, force: true })",',
      '  "  const file = path.join(root, \'.ai-runner\', \'lessons.md\')",',
      ']',
      '__AI__.writeText("t.js", arr.join(String.fromCharCode(10)))',
    ].join(NL)
    expect(scanNativeApisWithFallback(code).hit).toBe(false)
  })

  it('把 require(\'fs\') 当文本写入不拦截', () => {
    expect(scanNativeApis('__AI__.writeText("a.js", "const fs = require(\'fs\')")').hit).toBe(false)
  })

  it('含引号的正则字面量不破坏同行模块名识别', () => {
    expect(scanNativeApis('const re = /[\'"]/; const fs = require(\'fs\')').hit).toBe(true)
  })

  it('除号不被当成正则起始', () => {
    const code = ['const a = 6', 'const b = a / 2', 'const fs = require(\'fs\')'].join(NL)
    expect(scanNativeApis(code).hit).toBe(true)
  })

  // 承重：删掉「单双引号不跨行」中断后，本行会吞到下一行的引号，后续行漏检
  it('代码里未闭合的引号不吞掉后续行（防御性中断）', () => {
    const code = ['const a = \'oops', 'const fs = require(\'fs\')'].join(NL)
    expect(scanNativeApis(code).hit).toBe(true)
  })

  it('跨行模板字面量不破坏 @L 行号（旧实现会错位）', () => {
    const code = ['const t = `a', 'b`', 'const fs = require(\'fs\')'].join(NL)
    const r = scanNativeApisWithFallback(code)
    expect(r.hit).toBe(true)
    expect(r.matches[0]).toBe('require(fs) @L3')
  })

  it('降级标记仍按原行号回溯（剥离后行号不错位）', () => {
    const code = ['const t = `a', 'b`', '// __AI__.patchFile not found', 'const fs = require(\'fs\')'].join(NL)
    expect(scanNativeApisWithFallback(code).hit).toBe(false)
  })
})

// [ai-guard-eval-guard-v1] eval / Function 的实参是字符串却会被执行，必须单开通道
describe('动态执行通道 (eval / Function)', () => {
  it('eval("require(\'fs\')") 命中', () => {
    expect(scanNativeApis('eval("require(\'fs\')")').hit).toBe(true)
  })

  it('new Function("return process.exit(1)") 命中', () => {
    expect(scanNativeApis('const f = new Function("return process.exit(1)")').hit).toBe(true)
  })

  it('eval 含在字面量里时不触发字面量扫描', () => {
    expect(scanNativeApis('const s = "eval(\'fs.readFileSync\')"').hit).toBe(false)
  })
})
