---
name: ai-runner-loop-pattern
description: Reusable 3-phase playbook for AI Runner-style workbench featuring singleton state machines, cross-window postMessage bridges, fuse-based auto loops, and three-layer security. Use when building or refactoring an AI Runner workbench, or porting the pattern to similar projects. Do not use for ordinary web apps or one-off scripts.
---

# AI Runner Loop Pattern

Reusable 3-phase landing playbook distilled from `vite-plugin-ai-runner`. Compress any over-engineered "N-stage automated closed loop" design doc into 3 verifiable, rollbackable phases.

## When to use

- Building/refactoring an AI Runner-style workbench (auto loop + script sandbox + bridge to AI chat site).
- Porting the singleton + postMessage + fuse-loop pattern to a similar project.
- Reviewing a design doc that proposes 10+ phases for "automated AI closed loop" — compress it with the 3-phase rule first.

Do not use for ordinary web apps, static sites, or one-off scripts.

## Core principle: 3-phase compression

Any "N-stage automated closed loop" design can be compressed into:

1. **P0 — Foundation fixes**: invisible bugs that block everything (singleton leaks, dead code, broken parse).
2. **P1 — Minimum manual closed loop**: one end-to-end happy path you can drive by hand (contract → inbox → execute → trace). No automation yet.
3. **P2 — Auto loop + decision chain**: state machine + fuses + 3-button interrupt + persistence + per-loop commit. Pure logic抽 to a zero-dep module locked by unit tests.

Cut anything that is not on the critical path: anti-detection hooks, parallel cjs, inline comments, sandbox 3-tier UI, budget-limited soft-stop, auto session rotation. Each of these is a 5+ failure-mode tax with no payoff in the first iteration.

## Core conventions

### 1. Composable singleton — module-level refs

State-bearing composables hold refs at **module level**, not inside the factory function. The factory only returns references.

```typescript
// ❌ causes watcher accumulation + memory leak on re-import
export function useRunner() {
  const logs = ref([])
  watch(logs, ...)
  return { logs }
}

// ✅ singleton: refs at module level, factory returns references
const logs = ref([])
let watchBound = false
export function useRunner() {
  if (!watchBound) { watch(logs, ...); watchBound = true }
  return { logs }
}
```

Applies to: `useRunner`, `useAutoLoop`, `useScriptInbox`, `useToast`, `useSessionManager`, `useTraceLog`.

### 2. Cross-window postMessage — precise origin

Bridge to AI chat site uses **exact origin** string, never `'*'`. Validate `event.origin` against an allowlist and compare `event.source` to the active window handle.

Protocol families (exact `kind` enum, versioned by adding not renaming):
- `ai-runner:fill` — workbench → AI site, inject prompt into input box.
- `ai-runner:stop` — workbench → AI site, clear seen-hash and stop reply.
- `ai-runner:reply` — AI site → workbench, `kind: script | done | plain | multi`.
- `ai-runner:session-id`, `ai-runner:token-estimate` — auxiliary.

### 3. Fuse-based auto loop — 7 fuses

Pure functions in `loopLogic.ts` (zero vue/DOM/sessionStorage dep, lockable by `node:test`):

| # | Fuse | Trigger | Action |
|---|------|---------|--------|
| 1 | Strict DONE | `^\s*DONE\s*$` only | natural finish |
| 2 | Tolerance budget | format error / plain text / duplicate script | retry until budget=0 then break |
| 3 | Round limit | round ≥ 8 | break |
| 4 | Token budget | token delta ≥ 30k | break (priority over round limit) |
| 5 | Bash blacklist | 10 patterns (rm -rf, sudo, curl\|sh, …) | 400 pre-exec |
| 6 | User 3-level interrupt | Esc=pause / ■=kill / Ctrl+Esc=rollback | stopped \| interrupted |
| 7 | Per-round timeout | 90s no AI reply | break with reason |

**Priority lock**: when #3 and #4 both fire on the same round, **token-budget wins**. Single test case fixes this — without it, regressions are silent.

### 4. Three-layer security

- **Layer 1 — bash static blacklist** (`bash-guard.ts`): 10 patterns + env allowlist (8 keys).
- **Layer 2 — CJS read blacklist** (`interceptor.cjs`): 7 sensitive path patterns (`.env`, `.git/config`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `.ai-runner/config.json`). readFileSync/statSync/accessSync/realpathSync/openSync throw `EACCES`; existsSync returns `false` silently.
- **Layer 3 — git fallback** (`git.ts`): `preExecCheck` (dirty workspace) + `gitCommitAll` (loop-level atomic commit) + `gitResetHard` (user rollback, ref whitelist regex `[^\w.~^/-]`).

### 5. Pure logic抽 + node:test

Every fuse/decision/contract-prompt lives in a zero-dep module (`loopLogic.ts`) consumed by the Vue state machine (`useAutoLoop.ts`). Unit tests use `node:test` + `assert/strict`, `.ts` explicit extension imports. Aim ≥ 1 test per fuse to lock regression behavior.

### 6. AI output contract — single code block

AI-generated scripts must:
- Start with shebang (`#!/usr/bin/env node` for cjs, `#!/usr/bin/env bash` for bash), no hardcoded paths.
- First comments carry `@desc:` and `@why:` (regex `/^*(?:|#)*@(desc|why)*:*(.+)$/gm`).
- Single fenced code block, no nested triple-backticks.
- Terminate with exact `DONE` on its own line when the goal is complete.

### 7. Tampermonkey bridge — generic site adapter

Userscript scans `pre code[language-cjs|bash]` + leaf-element `^\s*DONE\s*$` + body-tail signature (300 chars) for plain-text dedup. Reply classification after 2s silence: `script` (new hash) / `done` (leaf DONE) / `plain` (signature changed, no code) / `multi` (>1 new code block = contract violation).

## Reference anchors in this repo

Treat these as concrete examples when porting:

- Singleton pattern — [client/composables/useRunner.ts](file:///Users/apple/vite-plugin-ai-runner/client/composables/useRunner.ts)
- Pure logic + fuses — [client/composables/loopLogic.ts](file:///Users/apple/vite-plugin-ai-runner/client/composables/loopLogic.ts) and [client/loopLogic.node-test.ts](file:///Users/apple/vite-plugin-ai-runner/client/loopLogic.node-test.ts)
- State machine consuming pure logic — [client/composables/useAutoLoop.ts](file:///Users/apple/vite-plugin-ai-runner/client/composables/useAutoLoop.ts)
- Cross-window bridge + active window handle — [client/composables/useDeepseekUrl.ts](file:///Users/apple/vite-plugin-ai-runner/client/composables/useDeepseekUrl.ts)
- Bash blacklist — [src/bash-guard.ts](file:///Users/apple/vite-plugin-ai-runner/src/bash-guard.ts)
- CJS read blacklist — [src/interceptor.cjs](file:///Users/apple/vite-plugin-ai-runner/src/interceptor.cjs)
- Git fallback — [src/git.ts](file:///Users/apple/vite-plugin-ai-runner/src/git.ts)
- AI output contract — [skills/gen-script-rules.md](file:///Users/apple/vite-plugin-ai-runner/skills/gen-script-rules.md)
- Tampermonkey bridge — [tampermonkey-session-id.user.js](file:///Users/apple/vite-plugin-ai-runner/tampermonkey-session-id.user.js)

## Reference docs

- [Phase checklist](file:///Users/apple/vite-plugin-ai-runner/.trae/skills/ai-runner-loop-pattern/references/phase-checklist.md) — step-by-step落地 for P0/P1/P2, with verification points.
- [Fuse and contract spec](file:///Users/apple/vite-plugin-ai-runner/.trae/skills/ai-runner-loop-pattern/references/fuse-contract-spec.md) — full fuse table, AI output contract, and tolerance budget math.

## Procedure

1. **Read the design doc / task brief.** Identify the "N-stage automated closed loop" claim. Map each stage to P0/P1/P2-or-cut using the compression rule above.
2. **P0 first.** Singletonize state-bearing composables, delete dead code referenced in README/tests, fix parse/contract functions. Verify with `tsc --noEmit`.
3. **P1 manual closed loop.** Drive one full path by hand: write contract → open AI site → fill prompt → receive script → execute → trace. Use `?mock=1` channel if no real site. Verify 8 end-to-end验收 points (auto-fill / blacklist block / read sandbox).
4. **P2 auto loop.** Build state machine consuming `loopLogic.ts` pure module. Implement 7 fuses, 3-button interrupt, sessionStorage persistence (refresh → stopped, never auto-resume — active window handle is stale), per-loop commit, userscript reply 4-class.
5. **Test coverage gap.**抽 pure logic to zero-dep module, write ≥ 1 test per fuse. Priority-lock test (#3+#4 same round) is mandatory.
6. **Verify.** `tsc --noEmit` + `node --test --experimental-strip-types client/*.node-test.ts src/*.test.cjs` + `vite build`. All green before declaring done.
