# Fuse and Contract Spec

## 7 fuses — full table

| # | Fuse | Trigger condition | Action | Pure function |
|---|------|-------------------|--------|---------------|
| 1 | Strict DONE | `^\s*DONE\s*$` matches a leaf text element exactly | Natural finish (`stopped`, reason `done`) | `isStrictDone(text)` |
| 2 | Tolerance budget | Format error / plain-text reply / duplicate script hash | Retry with `buildRetryPrompt(detail)` until `toleranceLeft` reaches 0, then break | `decideTolerance(leftBefore)` |
| 3 | Round limit | `round >= LOOP_MAX_ROUNDS` (8) | Break with reason `round-limit` | `checkRoundBreak` returns `'round-limit'` |
| 4 | Token budget | `max(0, tokenDelta) >= LOOP_TOKEN_BUDGET` (30_000) | Break with reason `token-budget` | `checkRoundBreak` returns `'token-budget'` |
| 5 | Bash blacklist | Script matches one of 10 patterns | 400 pre-exec, break with reason `bash-blacklist` | `bash-guard.ts` `isBlacklisted(code)` |
| 6 | User 3-level interrupt | Esc=pause / ■=kill / Ctrl+Esc=rollback | `stopped` for pause-then-kill; `interrupted` for rollback | `useAutoLoop` `stopRequest` ref |
| 7 | Per-round timeout | 90s no AI reply in `waiting` state | Break with reason `round-timeout` | `LOOP_ROUND_TIMEOUT_MS` constant |

### Priority lock

When #3 and #4 both fire on the same round, **#4 (token-budget) wins**. `checkRoundBreak` checks token first:

```typescript
export function checkRoundBreak(round: number, tokenDelta: number): RoundBreak {
  if (Math.max(0, tokenDelta) >= LOOP_TOKEN_BUDGET) return 'token-budget'
  if (round >= LOOP_MAX_ROUNDS) return 'round-limit'
  return 'continue'
}
```

Rationale: token overflow is a hard external limit (API cost); round count is an internal budget. External limits take precedence.

### Negative clamp

`Math.max(0, tokenDelta)` guards against negative deltas (token counter reset / model context window compaction). Without the clamp, a negative delta would always pass the budget check.

## Tolerance budget math

```typescript
export type ToleranceResult = { action: 'retry', remaining: number } | { action: 'break' }

export function decideTolerance(leftBefore: number): ToleranceResult {
  if (leftBefore > 0) return { action: 'retry', remaining: leftBefore - 1 }
  return { action: 'break' }
}
```

- `LOOP_TOLERANCE_BUDGET = 1` means: 1 retry allowed, second failure breaks.
- Shared across 3 failure modes: format-error / plain-text / duplicate-script.
- On retry: `toleranceLeft` decrements; `buildRetryPrompt(detail)` is sent to AI asking for a corrected single code block.
- On break: state → `stopped` with reason `tolerance-exhausted`.

## AI output contract

Full spec in [skills/gen-script-rules.md](file:///Users/apple/vite-plugin-ai-runner/skills/gen-script-rules.md). Summary:

1. **Shebang first** — `#!/usr/bin/env node` for cjs, `#!/usr/bin/env bash` for bash. No hardcoded paths (`/usr/local/bin/node`).
2. **Comments second** — `@desc:` and `@why:` on the first lines. Regex: `/^*(?:|#)*@(desc|why)*:*(.+)$/gm`.
3. **Single code block** — exactly one fenced code block per reply. No nested triple-backticks.
4. **DONE terminator** — when the goal is complete, reply with `DONE` on its own line. Strict match: `^\s*DONE\s*$`. "this is done" or "Done!" do not match.
5. **No plain-text-only replies** — if no code block, the reply is `plain` → tolerance fuse fires.
6. **No multi-block replies** — >1 code block is `multi` → tolerance fuse fires (contract violation).

## Feedback format — `buildFeedback`

`buildFeedback(outcome, ctx)` returns the text回填 to AI after each round. Structure:

```
@desc: <echoed desc>
@why: <echoed why>
语言: cjs | bash
退出码: 0 | non-zero
耗时: 234ms
变更文件数: 3
变更文件（最多 10 个）:
  M  src/index.ts
  A  client/foo.ts
  D  client/bar.ts
stdout 末尾（最多 3000 字符）:
  <tailClip(stdout, 3000)>
[如果失败]
stderr:
  <tailClip(stderr, 3000)>
[末尾推进指令]
请基于以上结果继续推进目标，或回复 DONE。
```

- `tailClip(text, max)` keeps the **tail** of the text (most recent output), not the head. `s.slice(-max)`.
- File list cap 10 — long diffs add noise without signal.
- 末尾推进指令 is a fixed string, not a per-round variation — AI model behavior is more stable with a constant suffix.

## `tailClip` — tail-preserving truncate

```typescript
export function tailClip(text: string, max: number = LOOP_FEEDBACK_TAIL): string {
  const s = String(text ?? '')
  return s.length > max ? s.slice(-max) : s
}
```

Why tail not head: the most recent output (error message, final log line) carries the signal for the next round. Truncating the head loses nothing actionable.

**Test data pitfall**: when testing "tail preserved", the data must have a distinct HEAD marker and TAIL marker. `'a' × 4000 + 'TAIL_MARK'` fails the assertion because the tail-3000 window still starts with `a` — the test data is wrong, not the implementation. Use `'HEAD_TOKEN_' + 'a' × 4000 + 'TAIL_MARK'` so the head marker is genuinely outside the tail window.
