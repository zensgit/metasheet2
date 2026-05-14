# Multitable Feishu Phase 3 — Delegate Gate Strict Status Hardening (Verification)

- Date: 2026-05-14
- Branch: `codex/multitable-phase3-delegate-gate-strict-status-20260514`
- Base: `origin/main` at `855ba871e` (after #1547 automation soak gate)
- Author: Claude (Opus 4.7, 1M context), interactive harness; operator-supervised
- Companion: `multitable-phase3-delegate-gate-strict-status-development-20260514.md`
- Redaction policy: this document contains no AI provider key, SMTP
  credential, JWT, bearer token, DingTalk webhook URL or robot
  `SEC...`, K3 endpoint password, recipient user id, temporary
  password, or `.env` content.

## Result

**PASS / hardening landing**.

- **44 / 44 tests PASS** with `pnpm install` done in the worktree
  (which is the CI baseline).
- Without `pnpm install`, **40 / 44 PASS** — the 4 failing tests are
  pre-existing spawn-based integration tests that require
  `node_modules/.bin/tsx`; they have the same failure mode on
  `origin/main` before this PR. They are not regressions; my changes
  do not alter their spawn or runtime behavior.

## V1 — Worktree provenance

```bash
git fetch origin main
git worktree add /private/tmp/ms2-phase3-hardening-20260514 \
  -b codex/multitable-phase3-delegate-gate-strict-status-20260514 origin/main
```

Result: `HEAD is now at 855ba871e test(multitable): add phase3
automation soak gate (#1547)`.

## V2 — Focused tests (with `pnpm install`)

```bash
pnpm install --frozen-lockfile --prefer-offline
node --test scripts/ops/multitable-phase3-release-gate.test.mjs
```

Result:

```text
ℹ tests 44
ℹ pass 44
ℹ fail 0
ℹ skipped 0
```

Breakdown:

- **16 pre-existing tests** (baseline before this PR) all pass with
  the new translator. The strict translator is a no-op for the
  passing real spawn cases (`email exit=2 + status=blocked → blocked`
  remains blocked; `automation exit=2 + status=blocked → blocked`
  remains blocked).
- **28 new tests** added by this PR. All pass without `pnpm install`
  too, because they use in-process mock `spawnFn` injection.

## V3 — Sibling test files unchanged

```bash
node --test scripts/ops/multitable-phase3-release-gate-redact.test.mjs \
            scripts/ops/multitable-phase3-release-gate-report.test.mjs
```

Result:

```text
ℹ tests 24
ℹ pass 24
ℹ fail 0
```

Confirms no collateral damage to the redactor or report writer.

## V4 — New translator unit tests (14 cases)

```bash
node --test scripts/ops/multitable-phase3-release-gate.test.mjs 2>&1 \
  | grep 'translateDelegateStatus'
```

Result (all PASS):

```text
✔ translateDelegateStatus — email pass case: exit=0 + status=pass + ok=true → pass
✔ translateDelegateStatus — email blocked case: exit=2 + status=blocked → blocked
✔ translateDelegateStatus — email mismatch: exit=0 + status=blocked (script bug) → fail-closed
✔ translateDelegateStatus — email mismatch: exit=2 + status=pass → fail-closed
✔ translateDelegateStatus — email mismatch: exit=0 + status=pass + ok=false → fail-closed
✔ translateDelegateStatus — email mismatch: exit=0 + status=pass + ok missing → fail-closed
✔ translateDelegateStatus — automation pass: exit=0 + status=pass (no ok required) → pass
✔ translateDelegateStatus — automation blocked: exit=2 + status=blocked → blocked
✔ translateDelegateStatus — automation mismatch: exit=0 + status=blocked → fail-closed
✔ translateDelegateStatus — automation mismatch: exit=2 + status=pass → fail-closed
✔ translateDelegateStatus — child report missing → fail-closed
✔ translateDelegateStatus — child report non-object (parse failure already returned null) → fail-closed
✔ translateDelegateStatus — spawn error (ENOENT) → fail-closed
✔ translateDelegateStatus — null exit (signal kill) → fail-closed
```

## V5 — Delegate state-machine tests (6 cases)

```bash
node --test scripts/ops/multitable-phase3-release-gate.test.mjs 2>&1 \
  | grep 'delegate with mock'
```

Result (all PASS):

```text
✔ email delegate with mock — pass case round-trips through translator
✔ email delegate with mock — mismatch (exit=0 + status=blocked) is FAIL not PASS
✔ email delegate with mock — child report missing → FAIL
✔ automation delegate with mock — pass case round-trips through translator
✔ automation delegate with mock — mismatch (exit=0 + status=blocked) is FAIL not PASS
✔ automation delegate with mock — spawn ENOENT → FAIL
```

Each test injects a mock `spawnFn` that simulates a specific child
behavior (exit + report), runs the real delegate function in-process,
and asserts the resulting status / exitCode / reason against the
strict-translation contract.

## V6 — Aggregator state machine tests (5 cases)

```bash
node --test scripts/ops/multitable-phase3-release-gate.test.mjs 2>&1 \
  | grep 'aggregator state machine'
```

Result (all PASS):

```text
✔ aggregator state machine — email PASS + automation BLOCKED + 2 D0 BLOCKED → BLOCKED (does NOT collapse to PASS)
✔ aggregator state machine — email FAIL + automation BLOCKED + 2 D0 BLOCKED → FAIL (any delegate fail → aggregate fail)
✔ aggregator state machine — automation FAIL beats email PASS + others BLOCKED → FAIL
✔ aggregator state machine — email mismatch (exit=0 + status=blocked) → aggregate FAIL
✔ aggregator state machine — automation mismatch (exit=2 + status=pass) → aggregate FAIL
```

The "partial PASS does not collapse to PASS" invariant is preserved.
Mismatches in either delegate now poison the aggregate to FAIL,
matching the strict-translation contract.

## V7 — Artifact-integrity tests (3 cases)

```bash
node --test scripts/ops/multitable-phase3-release-gate.test.mjs 2>&1 \
  | grep -E 'real SMTP env values do not leak|webhook URLs and auth tokens|aggregator report\.json does not include dirty samples'
```

Result (all PASS):

```text
✔ artifact integrity — real SMTP env values do not leak via delegate childStdoutSample / childStderrSample (email)
✔ artifact integrity — webhook URLs and auth tokens do not leak via automation delegate samples
✔ artifact integrity — Phase 3 aggregator report.json does not include dirty samples raw
```

These cover the user's explicit requirement that real SMTP, webhook,
and token env values do not appear in Phase 3 JSON / MD / stdout /
stderr after the bridge runs. The tests inject worst-case dirty
content (env-shaped key=value assignments, full SMTP credentials,
real recipient email shapes, Bearer / sk- / OPENAI_API_KEY patterns,
webhook URLs with embedded `access_token` parameters) into the mock
spawn result, then assert these substrings do not survive into the
delegate samples or the aggregator report.

## V8 — Scope check

```bash
git diff --cached --name-only
```

Result:

```text
docs/development/multitable-phase3-delegate-gate-strict-status-development-20260514.md
docs/development/multitable-phase3-delegate-gate-strict-status-verification-20260514.md
scripts/ops/multitable-phase3-release-gate.mjs
scripts/ops/multitable-phase3-release-gate.test.mjs
```

No file under `plugins/plugin-integration-core/`, `lib/adapters/`,
`packages/`, `apps/`, `.github/workflows/`, `docker/`, or any
migration directory is modified. Stage-1 lock compliance affirmed.

## V9 — Whitespace and conflict-marker check

```bash
git diff --cached --check
```

Result: clean (reported at staging time).

## V10 — Secret-pattern scan

```bash
grep -rEn --include='*.mjs' --include='*.md' \
  '(SEC[A-Z0-9+/=_-]{8,}|Bearer[[:space:]]+[A-Za-z0-9._-]{20,}|eyJ[A-Za-z0-9._-]{20,}|sk-[A-Za-z0-9_-]{20,}|DINGTALK_CLIENT_SECRET[[:space:]]*=[[:space:]]*[A-Za-z][A-Za-z0-9_]+)' \
  scripts/ops/multitable-phase3-release-gate.mjs \
  scripts/ops/multitable-phase3-release-gate.test.mjs \
  docs/development/multitable-phase3-delegate-gate-strict-status-*-20260514.md
```

Result: only `.test.mjs` fixture matches surface, all inside
`assert.doesNotMatch(...)` / `assert.match(...)` clauses proving
redaction. No real provider key, robot SEC, JWT, SMTP password, or
client secret is committed.

## V11 — Stage-1 lock self-attestation

| Check | Result |
| --- | --- |
| No change under `plugins/plugin-integration-core/*` | PASS |
| No change under `lib/adapters/k3-wise-*` | PASS |
| No new product战线 | PASS |
| No schema / migration / route / workflow change | PASS |
| No change to `multitable-email-real-send-smoke.ts`, `multitable-automation-soak.mjs`, or any other delegate harness | PASS |
| No change to `verify:multitable-email:*` or `verify:multitable-automation:soak` package scripts | PASS |
| No new package script | PASS |
| Kernel polish on shipped release-gate aggregator | PASS |

## V12 — Translator semantic table (cross-checked against tests)

| sourceExitCode | report.status | report.ok | Email translation | Automation translation |
| --- | --- | --- | --- | --- |
| `0` | `'pass'` | `true` | **pass** | **pass** |
| `0` | `'pass'` | `false` | fail (ok mismatch) | n/a (no ok field) |
| `0` | `'pass'` | (missing) | fail (ok missing) | **pass** |
| `0` | `'blocked'` | any | **fail** (status mismatch) | **fail** |
| `0` | `'failed'` / `'fail'` | any | **fail** | **fail** |
| `2` | `'blocked'` | any | **blocked** | **blocked** |
| `2` | `'pass'` | any | **fail** (status mismatch) | **fail** |
| `1` | any | any | **fail** | **fail** |
| `null` (signal kill) | any | any | **fail** | **fail** |
| any | (missing report) | n/a | **fail** | **fail** |
| any | (unparseable) | n/a | **fail** | **fail** |
| (spawn ENOENT) | n/a | n/a | **fail** | **fail** |

## Final verdict

PASS. The strict translator + diagnostic sample fields close the
`statusFromExitCode` correctness gap that was shared by PRs #1544
and #1547 on `main`. After this PR, a release gate that returns
`release:phase3 status=pass` carries a stronger guarantee than
"exit code agreed with itself" — every delegated child's exit code,
report.status, and (where applicable) report.ok must all agree, and
any inconsistency fails the gate closed.
