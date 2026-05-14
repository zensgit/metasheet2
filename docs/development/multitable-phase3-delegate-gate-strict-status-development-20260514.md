# Multitable Feishu Phase 3 — Delegate Gate Strict Status Hardening (Development)

- Date: 2026-05-14
- Branch: `codex/multitable-phase3-delegate-gate-strict-status-20260514`
- Base: `origin/main` at `855ba871e` (after #1547 automation soak gate)
- Author: Claude (Opus 4.7, 1M context), interactive harness; operator-supervised
- Redaction policy: this PR contains no AI provider key, SMTP
  credential, JWT, bearer token, DingTalk webhook URL or robot
  `SEC...`, K3 endpoint password, Agent ID value, recipient user id,
  temporary password, or `.env` content.

## Why this PR exists

PRs #1544 (D1 — email real-send delegate) and #1547 (D4 — automation
soak delegate) both wire their respective harnesses into the Phase 3
release gate via the same `child exit code → status` pattern:

```js
const status = child.error ? 'fail' : statusFromExitCode(childExitCode)
```

`statusFromExitCode(0) === 'pass'`, `statusFromExitCode(2) === 'blocked'`,
everything else `'fail'`. This trusts the child process's exit code
**without** checking that the child's `report.json` `status` / `ok`
fields agree with the exit code.

That gap means:

- If a delegated child script exits `0` but writes
  `report.status === 'blocked'` (script bug / racing redact /
  malformed I/O), the Phase 3 release gate reports **pass** even
  though the harness itself disagrees.
- If a child exits `2` but writes `report.status === 'pass'` (less
  likely but symmetric), the release gate reports **blocked** without
  flagging the inconsistency.
- If `report.ok === false` but exit code is `0`, the email harness's
  own "I did not succeed" signal is ignored.

For a release gate, this is the wrong direction: any disagreement
between exit code and report fields should be **fail-closed**, not
silently routed to the exit-code-implied state.

This PR introduces a strict translator covering both delegate gates
(email + automation) uniformly, and adds `childStdoutSample` /
`childStderrSample` (1200-char, redacted) for diagnostic value when a
delegated child fails.

## Scope

In scope (this PR):

- Strict translation of delegate gate status for both email and
  automation.
- Mismatch detection: spawn error, signal-kill (null exit), missing
  / unparseable child report.json, exit / status / ok inconsistency
  all map to **fail** (exit 1).
- Diagnostic samples: `childStdoutSample` and `childStderrSample`
  in delegate return shape, redacted via the existing Phase 3
  redactor and capped at 1200 characters.
- `spawnFn` injection option on both delegate functions so tests can
  drive the full state machine in-process without invoking pnpm.
- Test coverage spanning the translator, both delegate functions
  with mock spawn, and the aggregator state machine.

Out of scope:

- No change to `scripts/ops/multitable-email-real-send-smoke.ts`.
- No change to `scripts/ops/multitable-automation-soak.mjs`.
- No change to `verify:multitable-email:*` or
  `verify:multitable-automation:soak` package scripts.
- No new package script.
- No change under `plugins/plugin-integration-core/*`,
  `lib/adapters/k3-wise-*`, multitable runtime, OpenAPI, migrations,
  routes, workflows.

## Strict translation contract

The new `translateDelegateStatus` function (exported for tests):

```js
translateDelegateStatus({ gate, childExitCode, childError, childReport })
  // → { status, exitCode, mismatchReason }
```

Rules:

- **PASS** iff:
  - `childExitCode === 0`, AND
  - `childReport.status === 'pass'`, AND
  - if delegate `requiresOkField` (email only): `childReport.ok === true`.

- **BLOCKED** iff:
  - `childExitCode === 2`, AND
  - `childReport.status === 'blocked'`.

- **FAIL** in every other case, including:
  - Spawn launch error (e.g. `ENOENT`).
  - Non-numeric exit code (signal kill, spawn aborted).
  - Missing or unparseable child report.json.
  - Exit / status / ok inconsistency.

`mismatchReason` is `null` for PASS and BLOCKED; for FAIL it carries
a redaction-safe explanation. Examples (verbatim from tests):

- `Fail-closed: child exit=0 report.status=blocked ok=false — did not match pass (exit=0, status=pass, ok=true) or blocked (exit=2, status=blocked) contracts.`
- `Spawn launch error: spawn pnpm ENOENT`
- `Child exit code was not numeric (signal kill or spawn aborted): null.`
- `Child report.json missing or unparseable; release gate cannot verify exit-code / report consistency.`

## Delegate-side changes

Both `runEmailRealSendGate` and `runAutomationSoakGate` now:

1. Use `options.spawnFn ?? spawnSync` (allows mock injection).
2. Call `translateDelegateStatus` instead of `statusFromExitCode`.
3. When `mismatchReason` is set, the gate's `reason` field surfaces
   that mismatch directly so the report.json / report.md shows why
   the delegate failed-closed.
4. Add `childStdoutSample` and `childStderrSample` fields to the
   return object, each redacted and capped at 1200 chars.
5. `childExitCode` becomes `null` when child status was non-numeric
   (signal kill), instead of being silently coerced to `EXIT_FAIL=1`.
6. `childOk` becomes `null` instead of being inferred from
   `status === 'pass'`, so the raw report value is preserved or
   `null` if absent.

The runner's CLI behavior, gate ids, and output paths are unchanged.

## Test coverage

The hardening PR adds **28 new tests** to
`scripts/ops/multitable-phase3-release-gate.test.mjs`:

- **14 translator unit tests** covering: email pass, email blocked,
  4 email mismatch flavors (`exit=0 + status=blocked`,
  `exit=2 + status=pass`, `exit=0 + status=pass + ok=false`,
  `exit=0 + status=pass + ok=missing`), automation pass, automation
  blocked, 2 automation mismatch flavors, missing report,
  non-object report, spawn `ENOENT`, signal-kill null exit.
- **6 in-process delegate tests** with mock `spawnFn`: email pass
  / mismatch / missing report; automation pass / mismatch / spawn
  error.
- **5 aggregator state machine tests** with routed mock `spawnFn`:
  email PASS + 3 BLOCKED → BLOCKED (partial PASS does not collapse);
  email FAIL + others BLOCKED → FAIL; automation FAIL beats email
  PASS → FAIL; email mismatch → aggregate FAIL; automation mismatch
  → aggregate FAIL.
- **3 artifact-integrity tests**: real SMTP env-value redaction in
  email delegate samples; webhook + auth-token redaction in
  automation delegate samples; aggregator report.json carries no
  raw delegate stdout / stderr.

All 28 new tests are pure in-process (no `pnpm` spawn dependency,
no `node_modules/.bin/tsx` requirement). Pre-existing spawn-based
tests continue to pass when `pnpm install` has run; in a fresh
worktree they fail at the spawn step with `pnpm: tsx: command not
found` (this is the same baseline behavior on `origin/main` before
this PR — not a regression).

## Files

| Path | Change | Note |
| --- | --- | --- |
| `scripts/ops/multitable-phase3-release-gate.mjs` | modify | Replace `statusFromExitCode` with `translateDelegateStatus`; add `compactSample`; refactor both delegate functions to use translator + add samples + spawnFn injection; export `translateDelegateStatus`. |
| `scripts/ops/multitable-phase3-release-gate.test.mjs` | modify | Import translator; add 28 new tests as described above. |
| `docs/development/multitable-phase3-delegate-gate-strict-status-development-20260514.md` | new | this file |
| `docs/development/multitable-phase3-delegate-gate-strict-status-verification-20260514.md` | new | verification MD |

No other file is touched.

## Stage-1 lock compliance

| Check | Result |
| --- | --- |
| No change under `plugins/plugin-integration-core/*` | PASS |
| No change under `lib/adapters/k3-wise-*` | PASS |
| No new product战线 | PASS — hardening on already-shipped delegate gates |
| No schema / migration / route / workflow change | PASS |
| No change to email or automation harness scripts | PASS |
| No change to `verify:multitable-email:*` or `verify:multitable-automation:soak` package scripts | PASS |
| No new package script | PASS |
| Kernel polish on shipped release-gate aggregator | PASS |

## Cross-references

- Plan: `docs/development/multitable-feishu-phase3-ai-hardening-plan-20260514.md`
- TODO: `docs/development/multitable-feishu-phase3-ai-hardening-todo-20260514.md`
- Independent review: `docs/development/multitable-feishu-phase3-ai-hardening-review-20260514.md`
- D0 skeleton (#1541): merge commit `a92189533`
- D1 email delegate (#1544): merge commit `1f9061f56`
- D4 automation soak delegate (#1547): merge commit `855ba871e`
- Closed in favor of this PR: #1545 (Claude's parallel D1 implementation, closed as duplicate after Codex landed #1544)

## Follow-ups (not in this PR)

- If `pnpm install` precedes tests in CI (it does for Plugin System
  Tests), the previously-spawn-based tests continue to pass; if a
  future CI lane runs without `pnpm install`, those tests would need
  skip guards similar to PR R3's `existsSync('node_modules/.bin/tsx')`
  pattern. Out of scope for this hardening PR.
- D2 (perf large-table) and D3 (permission matrix) remain deferred
  under stage-1 lock plus T4 / T5 closure.
