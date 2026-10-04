import { describe, expect, it } from 'vitest'
import { parseDeepSeekCompletionError } from '../src/headless/ai-headless.js'

describe('parseDeepSeekCompletionError', () => {
  it('extracts a hint error from a successful HTTP completion stream', () => {
    const stream = 'event: ping\ndata: {}\n\nevent: hint\ndata: {"type":"error","content":"Server busy, please try again later.","finish_reason":"generation_timeout"}\n\nevent: close\ndata: {}\n\n'
    expect(parseDeepSeekCompletionError(stream)).toBe('Server busy, please try again later.')
  })

  it('ignores non-error hints and malformed events', () => {
    const stream = 'event: hint\ndata: {bad json}\n\nevent: hint\ndata: {"type":"meta","content":"ok"}\n\n'
    expect(parseDeepSeekCompletionError(stream)).toBeNull()
  })
})
