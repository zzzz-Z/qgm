# Phase Checklist

Step-by-step落地 for P0 / P1 / P2. Each phase ends with a verification gate — do not proceed until green.

## P0 — Foundation fixes

Goal: kill invisible bugs that block every later phase. No new features.

### P0.1 Singletonize state-bearing composables

- [ ] For each composable that holds refs (`useRunner`, `useSessionManager`, `useToast`, `useTraceLog`, later `useAutoLoop`/`useScriptInbox`): move `ref(...)` declarations to module level.
- [ ] Move `watch(...)` setup to module level or guard with a `let bound = false` flag inside the factory.
- [ ] Factory returns references to module-level state. No new state per call.
- [ ] Verify with `tsc --noEmit`.

**Why**: refs inside the factory cause watcher accumulation across re-imports (HMR, test re-evaluation) → memory leak + duplicate handlers.

### P0.2 Delete dead code

- [ ] Grep for any composable removed in refactor (e.g., `useScriptExecutor`).
- [ ] Remove the file. Grep again for stale imports / README references / test imports. Remove all.
- [ ] Verify with `tsc --noEmit`.

### P0.3 Fix parse / contract functions

- [ ] Rename `parseScriptDesc` → `parseScriptMeta` (or analogous) and extend regex to capture both `@desc` and `@why`: `/^*(?:|#)*@(desc|why)*:*(.+)$/gm`.
- [ ] Apply to both cjs and bash branches.
- [ ] Update `RunLogEntry` / `TraceEntry` types to include the new field.
- [ ] Verify with `tsc --noEmit`.

**Gate**: `tsc --noEmit` clean. Nothing else shipped in P0.

## P1 — Minimum manual closed loop

Goal: one end-to-end happy path drivable by hand. No automation, no fancy UI.

### P1.1 Write the AI output contract

- [ ] Create `skills/gen-script-rules.md` (or analogous). Document: single code block, shebang first, `@desc` + `@why` comments, no nested fences, exact `DONE` terminator.
- [ ] This is the spec both the AI and the workbench validate against.

### P1.2 Toast notifications — in-place update

- [ ] Toast composable uses unique `key` for in-place update (same key → replace content, not stack).
- [ ] Cap visible toasts to 3.

### P1.3 Script inbox — dedup queue

- [ ] `useScriptInbox` composable: queue + FNV-1a 32-bit hash (8 hex chars) for dedup.
- [ ] Override protection: same hash arriving twice does not enqueue a duplicate.

### P1.4 Cross-window bridge — active window handle

- [ ] `useDeepseekUrl` exports `getActiveWin()` / `openDeepseek(url)` / `sendFill` / `sendStop`.
- [ ] `window.open` calls route through `openDeepseek` to preserve the handle.
- [ ] `sendFill` / `sendStop` use **exact origin** (allowlist), never `'*'`.

### P1.5 Message router in root component

- [ ] `App.vue` (or equivalent) registers `window.addEventListener('message', onMessage)`.
- [ ] Validate `event.origin` against allowlist; compare `event.source === getActiveWin()` (skip in MOCK_MODE).
- [ ] Route by `data.type`: `ai-runner:reply` → script/done/plain/multi handlers; legacy `ai-runner:script` kept for back-compat.

### P1.6 UI panel — inbox + execute + trace

- [ ] `ScriptPanel.vue` shows inbox badge `📥 N`, calls `takeLatestFromInbox`.
- [ ] Execute button triggers cjs `/run` or bash `/exec`. Results land in `useTraceLog`.

### P1.7 TraceEntry types

- [ ] Add `'script'` kind to `TraceKind`. Each script arrival logs `desc` / `why` / `lang` / `hash`.

### P1.8 Bash static blacklist

- [ ] `src/bash-guard.ts` exports 10 blacklisted regex patterns (`rm -rf`, `sudo`, `curl|sh`, etc.).
- [ ] `/exec` route: check blacklist first → 400 if hit. Then env allowlist (8 keys). Then 120s timeout.

### P1.9 Git pre-exec check

- [ ] `src/git.ts` exports `gitHead`, `gitPreExecCheck` (returns single type with optional `dirty` / `files` / `reason`).
- [ ] `/exec` route: if `preExecCheck.dirty` and the script mutates files, refuse or commit-first per policy.

### P1.10 CJS read blacklist interceptor

- [ ] `src/interceptor.cjs` denies read access to 7 sensitive path patterns: `.env`, `.git/config`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `.ai-runner/config.json`.
- [ ] readFileSync/statSync/accessSync/realpathSync/openSync throw `EACCES`; existsSync returns `false`.

### P1.11 Tampermonkey userscript — fence scan + fill

- [ ] Userscript listens for `ai-runner:fill` (origin validated) and injects prompt into the AI site input box.
- [ ] Userscript scans `pre code[language-cjs|bash]` blocks and posts `ai-runner:script` (or `ai-runner:reply` kind=script) back to opener.

### P1.12 Mock channel

- [ ] `App.vue` honors `?mock=1`: synthesizes a cjs script message without opening a real AI site. First line `#!/usr/bin/env node`.
- [ ] Mock injection happens **before** the "no active session" early return, so mock works on a fresh tab.

**Gate**: 8 end-to-end验收 points
1. Fill prompt reaches AI input box.
2. AI script auto-fills workbench inbox.
3. Execute produces trace entry with `desc`/`why`.
4. Bash blacklist blocks `rm -rf` with 400.
5. CJS read blacklist throws EACCES on `.env`.
6. Git dirty workspace is detected.
7. Mock channel works end-to-end without real AI.
8. Trace panel shows script + run entries.

## P2 — Auto loop + decision chain

Goal: state machine that drives P1 components in a closed loop, with fuses and user interrupt.

### P2.1 Pure logic module

- [ ] Create `client/composables/loopLogic.ts`. Export constants (`LOOP_MAX_ROUNDS=8`, `LOOP_TOKEN_BUDGET=30_000`, `LOOP_TOLERANCE_BUDGET=1`, `LOOP_ROUND_TIMEOUT_MS=90_000`, `LOOP_FEEDBACK_TAIL=3000`) and pure functions: `isStrictDone`, `checkRoundBreak`, `decideTolerance`, `tailClip`, `buildInitialPrompt`, `buildRetryPrompt`, `buildFeedback`.
- [ ] Zero vue / DOM / sessionStorage imports.

### P2.2 State machine

- [ ] `useAutoLoop.ts` singleton composable. States: `idle / running / waiting / parsing / executing / feedback / stopped / interrupted`.
- [ ] Consumes `loopLogic` for every fuse decision.

### P2.3 Seven fuses

- [ ] Strict DONE — `onNonScriptReply` kind=done → natural finish.
- [ ] Tolerance budget — `toleranceFail` calls `decideTolerance(leftBefore)`: retry if >0 else break. Shared budget across format-error / plain-text / duplicate-script.
- [ ] Round + token limits — `afterRound` calls `checkRoundBreak(round, tokenDelta)`: token-budget wins over round-limit.
- [ ] Bash blacklist — `executeItem` bash branch: pre-check returns 400 → break with reason.
- [ ] User 3-level interrupt — Esc=pause / ■=kill / Ctrl+Esc=rollback. Pause waits for next round; kill stops; rollback calls `/git/reset` with start commit.
- [ ] Per-round timeout — `enterWaiting` sets 90s timer; on fire, finish with `round-timeout`.

### P2.4 Three-button UI

- [ ] `ScriptPanel.vue` adds loop control bar: goal input + `[⟳ 第 N/8 轮][tok/30k][宽容]` + `■` / `⏸` / `⏹` (kill / pause / rollback).
- [ ] `run` trace entries stamped with `currentLoopContext()`.

### P2.5 tab title progress

- [ ] `watch([loopState, loopRound])`: when active → `⟳ N/8 AI Runner`; when stopped+done → `✓ AI Runner（done）`; else restore original title.

### P2.6 Feedback format

- [ ] `buildFeedback(outcome, ctx)` returns the text回填 to AI: exit code / changes / stdout tail (cap 3000 chars) / file list (cap 10) / next-step directive.

### P2.7 TracePanel loopId folding

- [ ] `TracePanel.vue` `groups` computed aggregates entries by `payload.loopId`. Loop group header shows goal + decision count + max round. R{n} pill per entry.

### P2.8 sessionStorage persistence

- [ ] `persist()` writes loopId/goal/round/startCommit/startTokens/state/stopReason.
- [ ] `restore()` on load: if state was active, set to `stopped` with reason "页面刷新，循环已中止（请手动重开）". **Never auto-resume** — activeWin handle is stale.

### P2.9 Per-loop commit

- [ ] `gitCommitAll(message)` at loop end (clean workspace returns `empty: true`).
- [ ] `gitResetHard(ref)` for user rollback — ref whitelist regex `[^\w.~^/-]` filters dangerous chars.

### P2.10 Tampermonkey reply 4-class

- [ ] Userscript v1.3+: `scanNewBlocks` (new cjs/bash blocks, hash dedup) → `script`.
- [ ] `findNewDone` (leaf element `^\s*DONE\s*$`) → `done`.
- [ ] `bodySignature` (last 300 chars) changed, no code → `plain`.
- [ ] >1 new code block → `multi` (contract violation).
- [ ] `classifyAndPost` after 2s silence. Stop handler clears `seenHashes` / `seenDoneMarkers` / `lastBodySig`.

**Gate**: `tsc --noEmit` + `vite build` (98 modules) + git semantics (commit on clean returns empty) + ref injection regex (rejects `; rm -rf`).

## Final test coverage gate

- [ ]抽 all fuse / decision / contract-prompt logic into `loopLogic.ts` (zero vue/DOM dep).
- [ ] `client/loopLogic.node-test.ts` covers: DONE strict (4 legal + 7 illegal), round limit, token limit, negative clamp, priority lock (#3+#4 same round → token-budget), tolerance budget, tailClip, initial prompt keywords, feedback format (cjs/bash/failure/no-desc/long-truncate/file-list-cap-10/next-directive).
- [ ] `node --test --experimental-strip-types client/*.node-test.ts src/*.test.cjs` all green.

Priority-lock test is **mandatory** — without it, the #3+#4 same-round regression is silent.
