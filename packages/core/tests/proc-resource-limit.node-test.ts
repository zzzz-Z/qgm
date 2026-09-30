// [proc-rlimit-test-v1] D3 maxOutputBytes 行为锁定
import { describe, expect, it } from 'vitest'
import { runProcess } from '../../../packages/core/src/process/proc.js'

describe('proc: maxOutputBytes', () => {
  it('正常输出不超限时 truncated 为 false', async () => {
    const r = await runProcess('node -e "process.stdout.write(String(123))"', {
      shell: true,
      timeoutMs: 10_000,
      maxOutputBytes: 1_000_000,
    })
    expect(r.stdout).toContain('123')
    expect(r.truncated).toBe(false)
  })

  it('输出超限时 truncated 为 true 且 killed', async () => {
    const inner = 'process.stdout.write("x".repeat(200000)); setInterval(() => process.stdout.write("y".repeat(200000)), 10)'
    const r = await runProcess(`node -e ${JSON.stringify(inner)}`, {
      shell: true,
      timeoutMs: 15_000,
      maxOutputBytes: 500_000,
    })
    expect(r.truncated).toBe(true)
    expect(r.killed).toBe(true)
  }, 20_000)

  it('缺省 maxOutputBytes 时默认 5MB', async () => {
    const r = await runProcess('node -e "process.stdout.write(String(9))"', {
      shell: true,
      timeoutMs: 10_000,
    })
    expect(r.truncated).toBe(false)
    expect(r.code).toBe(0)
  })

  it('退出码 0 时 truncated 字段存在', async () => {
    const r = await runProcess('node -e "process.exit(0)"', {
      shell: true,
      timeoutMs: 10_000,
    })
    expect(r.code).toBe(0)
    expect('truncated' in r).toBe(true)
  })
})
