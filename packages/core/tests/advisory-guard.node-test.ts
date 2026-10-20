// [advisory-guard-v1] 软规则只提示不阻断：命中时 warnings 非空且 hit=false。
// [WHY] 全量日志里 sh -c cat 3379 次、硬编码绝对路径 739 次，但都存在合法用法，
//   不能进 FORBIDDEN 的 400 通道（第 283 行 CONSTRAINT：新增规则会波及既有脚本兼容性）。
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { scanNativeApisWithFallback } from '../src/post-run/ai-guard.js'

describe('ADVISORY 软规则', () => {
  it('sh -c cat 产生提示但不阻断', () => {
    const r = scanNativeApisWithFallback('const r = await __AI__.shell([\'sh\', \'-c\', \'cat foo.txt\'])')
    assert.equal(r.hit, false, '软规则不得阻断执行')
    assert.ok((r.warnings || []).some(w => w.includes('shell-cat-file')), '必须提示 shell-cat-file')
  })

  it('硬编码绝对路径产生提示但不阻断', () => {
    const r = scanNativeApisWithFallback('const p = \'/Users/someone/project/file.ts\'')
    assert.equal(r.hit, false)
    assert.ok((r.warnings || []).some(w => w.includes('hardcoded-abs-path')))
  })

  it('原生 API 仍被硬拦截（hit=true），不受分级影响', () => {
    const r = scanNativeApisWithFallback('const fs = require(\'fs\')')
    assert.equal(r.hit, true, 'FORBIDDEN 规则必须仍然拦截')
  })

  it('干净脚本既无 hit 也无 warnings', () => {
    const r = scanNativeApisWithFallback('const t = await __AI__.readText(\'a.txt\')')
    assert.equal(r.hit, false)
    assert.equal((r.warnings || []).length, 0)
  })
})
