// [ai-guard-fallback-v2] ai-guard 单测：§4.3 严格扫描、§4.4 降级豁免、§4.2 幂等注入
import { describe, expect, it } from 'vitest'
import { injectAiJsdoc, scanNativeApis, scanNativeApisWithFallback } from '../../../packages/core/src/post-run/ai-guard.js'

describe('scanNativeApis (§4.3)', () => {
  it('合规 __AI__ 脚本通过', () => {
    expect(scanNativeApis('const t = __AI__.readText(\'a.txt\')').hit).toBe(false)
  })
  it('require(fs) 命中', () => {
    expect(scanNativeApis('const fs = require(\'fs\')').hit).toBe(true)
  })
  it('fs.readFileSync 命中', () => {
    expect(scanNativeApis('fs.readFileSync(\'x\')').hit).toBe(true)
  })
  it('行注释 token 被忽略', () => {
    expect(scanNativeApis('// fs.readFileSync\nconst x=1').hit).toBe(false)
  })
  it('块注释 token 被忽略', () => {
    expect(scanNativeApis('/* path.join */\nconst x=1').hit).toBe(false)
  })
  it('process.exit 命中', () => {
    expect(scanNativeApis('process.exit(1)').hit).toBe(true)
  })
})

describe('scanNativeApisWithFallback (§4.4)', () => {
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

describe('injectAiJsdoc (§4.2)', () => {
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
