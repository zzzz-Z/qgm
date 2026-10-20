// [api-return-shape-guard-v1] 契约表必须覆盖实现的真实返回字段（源码级对账）。
// [WHY] vitest 环境无 __AI__ 全局，不能真调；而台账反复出现「凭记忆写字段名」事故。
// [CONSTRAINT] 子集语义：实现出现的键必须在契约表里；可选字段用 ? 标注。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'vitest'
import { API_RETURNS } from '../src/helpers/api-returns.js'

const shellSrc = readFileSync(new URL('../src/helpers/shell.cjs', import.meta.url), 'utf8')
const miscSrc = readFileSync(new URL('../src/helpers/misc.cjs', import.meta.url), 'utf8')

function keysFromReturns(src: string): string[] {
  const out = new Set<string>()
  for (const m of src.matchAll(/return \{([^}]*)\}/g)) {
    for (const k of m[1].matchAll(/(\w+)\s*:/g)) out.add(k[1])
  }
  return Array.from(out)
}

const norm = (a: readonly string[]): string[] => a.map((s: string) => s.replace(/\?$/, ''))

describe('__AI__ 返回形状契约（源码级）', () => {
  it('shell 的返回字段被契约表覆盖', () => {
    // [WHY] shell.cjs 内有多条 @returns、也有同名内部函数；按函数名截取代码段会抓错。
    //   改用唯一后缀「执行结果」定位 shell 本体那条声明。
    const m = shellSrc.match(/@returns \{Promise<\{([^}]*)\}>\}\s*执行结果/)
    assert.ok(m, '未找到 shell 本体 @returns 声明')
    const declared = Array.from(m[1].matchAll(/(\w+)\??:/g), x => x[1])
    const contract = new Set(norm(API_RETURNS.shell))
    for (const k of declared) assert.ok(contract.has(k), `shell 契约表缺字段: ${k}`)
  })
  it('syntaxCheck 各 return 分支字段被契约表覆盖', () => {
    const start = miscSrc.indexOf('function syntaxCheck')
    const end = miscSrc.indexOf('function flush', start)
    const body = miscSrc.slice(start, end)
    const keys = keysFromReturns(body)
    assert.ok(keys.length > 0, '未解析到 syntaxCheck return 字段')
    const contract = new Set(norm(API_RETURNS.syntaxCheck))
    for (const k of keys) assert.ok(contract.has(k), `syntaxCheck 契约表缺字段: ${k}`)
  })

  it('契约表不得声明 shell.exit', () => {
    assert.ok(!norm(API_RETURNS.shell).includes('exit'))
  })
})
