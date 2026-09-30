import { describe, expect, it } from 'vitest'
import {
  BASH_WHITELIST_CMDS,
  checkBashWhitelist,
  splitCommands,
} from '../../../packages/core/src/process/bash-guard.js'

describe('bash-guard: splitCommands', () => {
  it('按换行分', () => {
    expect(splitCommands('ls\ncat')).toEqual(['ls', 'cat'])
  })

  it('按 ; && || 分', () => {
    expect(splitCommands('ls; pwd && echo ok')).toEqual(['ls', 'pwd', 'echo ok'])
  })

  it('过滤空行', () => {
    expect(splitCommands('\n\nls\n\n')).toEqual(['ls'])
  })
})

describe('bash-guard: checkBashWhitelist', () => {
  it('全白名单命令 → allow', () => {
    const r = checkBashWhitelist('ls\ncat foo.txt')
    expect(r.verdict).toBe('allow')
  })

  it('含未白名单命令 → unknown', () => {
    const r = checkBashWhitelist('ls\nfoo-bar-baz')
    expect(r.verdict).toBe('unknown')
    expect(r.reason).toContain('foo-bar-baz')
  })

  it('空字符串 → allow', () => {
    expect(checkBashWhitelist('').verdict).toBe('allow')
  })

  it('白名单包含 ls / cat / git / pnpm', () => {
    expect(BASH_WHITELIST_CMDS).toContain('ls')
    expect(BASH_WHITELIST_CMDS).toContain('cat')
    expect(BASH_WHITELIST_CMDS).toContain('git')
    expect(BASH_WHITELIST_CMDS).toContain('pnpm')
  })
})
